import express from "express";
import rateLimit from "express-rate-limit";
import { openAI } from "../services/openai.js";
import { logChatMessage } from "../services/db.js";
import { getBrandConfig, buildRunInstructions } from "../config/brands.js";
import { ASSISTANT_ID, OPENAI_BASE, OPENAI_API_KEY } from "../config/env.js";
import { extractHandoff, isDuplicateHandoff, sanitizeHandoffPayload, hasMinimumHandoffData, inferHandoffFromText, resolveEmailRouting } from "../services/handoff.js";
import { sendHandoffEmail } from "../services/mail.js";
import { pushHandoffToSheets } from "../services/sheets.js";
import { getBrandTools } from "../config/tools.js";

const router = express.Router();

const chatLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

/* ==================== STREAMING (Typing Effect) — brandKey destekli ==================== */

/* OpenAI Assistants v2 SSE proxy: /threads/{threadId}/runs  +  { stream:true } */
/* OpenAI Assistants v2 SSE proxy: /threads/{threadId}/runs  +  { stream:true } */
router.post("/stream", chatLimiter, async (req, res) => {
    try {
        const { threadId, message, brandKey, visitorId, sessionId, source, meta } = req.body || {};

        console.log("[brand] incoming:", { brandKey });
        if (!threadId || !message) {
            return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
        }

        // BRAND: brandKey zorunlu ve whitelist kontrolü
        const brandCfg = getBrandConfig(brandKey);
        if (!brandCfg) {
            return res.status(403).json({ error: "unknown_brand", detail: "brandKey not allowed or missing" });
        }

        // 🔴 User mesajını logla
        await logChatMessage({
            brandKey,
            threadId,
            role: "user",
            text: message,
            rawText: message,
            handoff: null,
            visitorId,
            sessionId,
            source,
            meta
        });

        // SSE başlıkları
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });

        // 🔌 Düzenli nabız gönder
        const KA_MS = 20_000;
        const keepAlive = setInterval(() => {
            try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch { }
        }, KA_MS);

        let clientClosed = false;
        req.on("close", () => {
            clientClosed = true;
            try { clearInterval(keepAlive); } catch { }
            try { res.end(); } catch { }
        });

        // 1) Kullanıcı mesajını threade ekle
        await openAI(`/threads/${threadId}/messages`, {
            method: "POST",
            body: { role: "user", content: message },
        });

        // 2) Run'ı STREAM modda başlat (TOOLS DAHİL)
        let instructions = buildRunInstructions(brandKey, brandCfg);

        // RAG Context Injection
        try {
            const { searchSimilarChunks } = await import("../services/rag.js");
            const results = await searchSimilarChunks(brandKey, message);
            if (results && results.length > 0) {
                console.log(`[RAG-STREAM] Found ${results.length} chunks`);
                const contextText = results.map(r => `--- SOURCE START (Score: ${r.score.toFixed(2)}) ---\n${r.content}\n--- SOURCE END ---`).join("\n\n");
                instructions += `\n\n# KNOWLEDGE BASE CONTEXT (Use this to answer if relevant):\n${contextText}\n\nIMPORTANT: If the answer is found in the KNOWLEDGE BASE CONTEXT, use it. If not, fallback to your general knowledge but prioritize provided context.`;
            }
        } catch (err) {
            console.error("[RAG-STREAM] Context fetch failed:", err);
        }

        const runBody = {
            assistant_id: brandCfg.assistant_id || ASSISTANT_ID,
            stream: true,
            metadata: { brandKey },
            instructions: instructions,
            tools: getBrandTools(brandKey) // <--- TOOLS ACTIVE
        };

        let currentStream = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
                "OpenAI-Beta": "assistants=v2",
                "Accept": "text/event-stream",
            },
            body: JSON.stringify(runBody),
        });

        if (!currentStream.ok) {
            const errText = await currentStream.text();
            throw new Error(`OpenAI stream start failed ${currentStream.status}: ${errText}`);
        }

        // --- STREAM CONSUMER LOOP ---
        let runId = null;
        let requiresAction = false;
        let toolCallsBuffer = [];
        let assistantTextBuffer = "";

        const processStream = async (streamResponse) => {
            const decoder = new TextDecoder();
            const reader = streamResponse.body.getReader();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (clientClosed) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;
                    const dataStr = trimmed.slice(5).trim();
                    if (!dataStr || dataStr === "[DONE]") continue;

                    try {
                        const evt = JSON.parse(dataStr);

                        if (evt.object === "thread.run" && evt.id) {
                            runId = evt.id;
                        }

                        // 1) Delta Text
                        if (evt.object === "thread.message.delta" && evt.delta?.content) {
                            for (const c of evt.delta.content) {
                                if (c.type === "text" && c.text?.value) {
                                    assistantTextBuffer += c.text.value;
                                    if (!clientClosed) {
                                        res.write(`data: ${JSON.stringify(evt)}\n\n`);
                                    }
                                }
                            }
                        }

                        // 2) Tool Call Delta
                        if (evt.object === "thread.run.step.delta" && evt.delta?.step_details?.tool_calls) {
                            const calls = evt.delta.step_details.tool_calls;
                            for (const call of calls) {
                                const idx = call.index;
                                if (!toolCallsBuffer[idx]) {
                                    toolCallsBuffer[idx] = {
                                        index: idx,
                                        id: call.id,
                                        type: call.type,
                                        name: call.function?.name,
                                        args: ""
                                    };
                                }
                                if (call.function?.arguments) {
                                    toolCallsBuffer[idx].args += call.function.arguments;
                                }
                                if (call.id) toolCallsBuffer[idx].id = call.id;
                                if (call.function?.name) toolCallsBuffer[idx].name = call.function.name;
                            }
                        }

                        // 3) Requires Action
                        if (evt.object === "thread.run" && evt.status === "requires_action") {
                            requiresAction = true;
                            runId = evt.id;
                        }

                    } catch (err) { }
                }
            }
        };

        await processStream(currentStream);

        // --- TOOL HANDLING ---
        if (requiresAction && toolCallsBuffer.length > 0) {
            console.log("[stream][tool] Function Calling detected!");

            const toolOutputs = [];
            let handoffPayload = null;
            let handoffKind = "customer_request";

            for (const tool of toolCallsBuffer) {
                if (!tool) continue;
                console.log(`[stream][tool] executing ${tool.name}`, tool.args);

                try {
                    const args = JSON.parse(tool.args);

                    if (tool.name.includes("handoff") || tool.name.includes("lead")) {
                        handoffPayload = args;
                        const clean = sanitizeHandoffPayload(handoffPayload, handoffKind, brandCfg);

                        await sendHandoffEmail({ brandKey, kind: handoffKind, payload: clean, brandCfg });
                        await pushHandoffToSheets({
                            ts: new Date().toISOString(),
                            brandKey,
                            kind: handoffKind,
                            threadId,
                            visitorId: visitorId || null,
                            sessionId: sessionId || null,
                            source: source || null,
                            meta: meta || null,
                            payload: clean,
                            meeting_mode: clean?.preferred_meeting?.mode || "",
                            meeting_date: clean?.preferred_meeting?.date || "",
                            meeting_time: clean?.preferred_meeting?.time || ""
                        });

                        await logChatMessage({
                            brandKey,
                            threadId,
                            role: "system",
                            text: `[System] Tool executed: ${tool.name}`,
                            handoff: { kind: handoffKind, payload: clean },
                            visitorId, sessionId, source, meta
                        });
                    }

                    toolOutputs.push({
                        tool_call_id: tool.id,
                        output: JSON.stringify({ success: true, message: "Request received and forwarded." })
                    });

                } catch (e) {
                    console.error("[stream][tool] Execution failed:", e);
                    toolOutputs.push({
                        tool_call_id: tool.id,
                        output: JSON.stringify({ success: false, error: e.message })
                    });
                }
            }

            if (toolOutputs.length > 0 && runId) {
                console.log(`[stream][tool] Submitting outputs to Run ${runId}...`);
                const submitResp = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs/${runId}/submit_tool_outputs`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${OPENAI_API_KEY}`,
                        "Content-Type": "application/json",
                        "OpenAI-Beta": "assistants=v2",
                        "Accept": "text/event-stream",
                    },
                    body: JSON.stringify({ tool_outputs: toolOutputs, stream: true })
                });

                if (submitResp.ok) {
                    await processStream(submitResp);
                } else {
                    console.error("[stream][tool] Submit failed:", await submitResp.text());
                }
            }
        }

        if (assistantTextBuffer) {
            try {
                await logChatMessage({
                    brandKey,
                    threadId,
                    role: "assistant",
                    text: assistantTextBuffer,
                    rawText: assistantTextBuffer,
                    handoff: null,
                    visitorId,
                    sessionId,
                    source,
                    meta
                });
            } catch (e) { }
        }

        try { res.write("data: [DONE]\n\n"); } catch (__) { }
        clearInterval(keepAlive);
        res.end();

    } catch (e) {
        console.error("[stream] fatal:", e);
        try { res.write(`data: ${JSON.stringify({ error: "stream_failed" })}\n\n`); } catch (__) { }
        try { res.write("data: [DONE]\n\n"); } catch (__) { }
        try { res.end(); } catch (__) { }
    }
});

// 1) Thread oluştur
router.post("/init", chatLimiter, async (req, res) => {
    try {
        const brandKey = (req.body && req.body.brandKey) || (req.query && req.query.brandKey);

        // brandKey varsa whitelistten kontrol et, yoksa da sorun yapma (opsiyonel)
        let brandCfg = null;
        if (brandKey) {
            brandCfg = getBrandConfig(brandKey);
            if (!brandCfg) {
                return res.status(403).json({ error: "unknown_brand", detail: "brandKey not allowed" });
            }
        }

        // Thread oluştur (brandKey varsa metadata’ya yazalım)

        const thread = await openAI("/threads", {
            method: "POST",
            body: brandKey ? { metadata: { brandKey } } : {}
        });

        return res.json({ threadId: thread.id, brandKey: brandKey || null });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "init_failed", detail: String(e) });
    }
});

// 2) Mesaj gönder + run başlat + poll + yanıtı getir (brandKey destekli)
router.post("/message", chatLimiter, async (req, res) => {
    const { threadId, message, brandKey, visitorId, sessionId, source, meta } = req.body || {};

    console.log("[brand] incoming:", { brandKey });

    if (!threadId || !message) {
        return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
    }

    // BRAND: brandKey zorunlu ve whitelist kontrolü
    const brandCfg = getBrandConfig(brandKey);
    if (!brandCfg) {
        return res.status(403).json({ error: "unknown_brand", detail: "brandKey not allowed or missing" });
    }

    try {
        //  BURAYA: user mesajını logla
        await logChatMessage({
            brandKey,
            threadId,
            role: "user",
            text: message,
            rawText: message,
            handoff: null,
            visitorId,
            sessionId,
            source,
            meta
        });


        // 2.a) Mesajı threade ekle
        await openAI(`/threads/${threadId}/messages`, {
            method: "POST",
            body: { role: "user", content: message },
        });

        // 2.b) Run oluştur  (assistant_id: brand öncelikli, yoksa global fallback)
        const run = await openAI(`/threads/${threadId}/runs`, {
            method: "POST",
            body: {
                assistant_id: brandCfg.assistant_id || ASSISTANT_ID,
                metadata: { brandKey },

                // ✅ Emlak botu run talimatı (kritik)
                instructions: await (async () => {
                    let instr = buildRunInstructions(brandKey, brandCfg);
                    // RAG ENTEGRASYONU
                    try {
                        const { searchSimilarChunks } = await import("../services/rag.js");
                        const results = await searchSimilarChunks(brandKey, message);
                        if (results && results.length > 0) {
                            console.log(`[RAG] Found ${results.length} chunks for query: "${message}"`);
                            const contextText = results.map(r => `--- SOURCE START (Score: ${r.score.toFixed(2)}) ---\n${r.content}\n--- SOURCE END ---`).join("\n\n");
                            instr += `\n\n# KNOWLEDGE BASE CONTEXT (Use this to answer if relevant):\n${contextText}\n\nIMPORTANT: If the answer is found in the KNOWLEDGE BASE CONTEXT, use it. If not, fallback to your general knowledge but prioritize provided context.`;
                        }
                    } catch (err) {
                        console.error("[RAG] Context fetch failed:", err);
                    }
                    return instr;
                })()

            },
        });



        // 2.c) Run tamamlanana kadar bekle (poll)
        let runStatus = run.status;
        const runId = run.id;
        const started = Date.now();
        const TIMEOUT_MS = 180_000;

        while (runStatus !== "completed") {
            if (Date.now() - started > TIMEOUT_MS) {
                throw new Error("Run polling timeout");
            }
            await new Promise(r => setTimeout(r, 1200));
            const polled = await openAI(`/threads/${threadId}/runs/${runId}`);
            runStatus = polled.status;
            if (["failed", "cancelled", "expired"].includes(runStatus)) {
                throw new Error(`Run status: ${runStatus}`);
            }
        }

        // // 2.d) Mesajları çek (en yeni asistan mesajını al)

        const msgs = await openAI(`/threads/${threadId}/messages?order=desc&limit=10`);
        const assistantMsg = (msgs.data || []).find(m => m.role === "assistant");

        // İçerik metnini ayıkla (text parçaları)
        let rawAssistantText = "";
        if (assistantMsg && assistantMsg.content) {
            for (const part of assistantMsg.content) {
                if (part.type === "text" && part.text?.value) {
                    rawAssistantText += part.text.value + "\n";
                }
            }
            rawAssistantText = rawAssistantText.trim();
        }

        // Kullanıcıya asla code-fence göstermeyelim
        const stripFenced = (s = "") => s.replace(/```[\s\S]*?```/g, "").trim();
        let cleanText = stripFenced(rawAssistantText);


        {
            const handoffProbe = extractHandoff(rawAssistantText);
            if (!handoffProbe && /randevu|avukat|iletişime geç|arasın|ön görüşme/i.test(message)) {
                console.warn("[handoff] no block found; assistant raw text:", rawAssistantText.slice(0, 500));
            }
        }


        // --- Handoff JSON çıkar + e-posta ile gönder (brandConfig ile) ---
        let handoff = extractHandoff(rawAssistantText);

        // explicit yoksa metinden üret
        if (!handoff) {
            // fallback: User msg + Assistant msg
            const combinedContext = message + "\n" + rawAssistantText;
            const inferred = inferHandoffFromText(combinedContext);
            if (inferred) {
                handoff = inferred;
                console.log("[handoff][fallback][poll] inferred from text (with context)");
            }
        }

        // kullanıcıya dönecek metin her zaman temiz
        cleanText = stripFenced(rawAssistantText);


        if (handoff) {
            // duplicate engeli
            if (isDuplicateHandoff(threadId, handoff.payload)) {
                console.log("[handoff][gate][poll] blocked duplicate payload");
                handoff = null;
            }

            if (!handoff) {
                console.log("[handoff][poll] not sending (gated)");
            } else {
                try {
                    const clean = sanitizeHandoffPayload(handoff.payload, handoff.kind, brandCfg);

                    if (!hasMinimumHandoffData(clean)) {
                        console.log("[handoff][gate][poll] blocked (missing minimum data)");
                    } else {
                        await sendHandoffEmail({
                            brandKey,
                            kind: handoff.kind,
                            payload: clean,
                            brandCfg,
                        });

                        await pushHandoffToSheets({
                            ts: new Date().toISOString(),
                            brandKey,
                            kind: handoff.kind,
                            threadId,
                            visitorId: visitorId || null,
                            sessionId: sessionId || null,
                            source: source || null,
                            meta: meta || null,
                            payload: clean,
                            // Flattened meeting fields for easy Sheets usage
                            meeting_mode: clean?.preferred_meeting?.mode || "",
                            meeting_date: clean?.preferred_meeting?.date || "",
                            meeting_time: clean?.preferred_meeting?.time || ""
                        });

                        console.log("[handoff][poll] SENT", { kind: handoff.kind });


                    }
                } catch (e) {
                    console.error("[handoff][poll] email failed or dropped:", {
                        message: e?.message,
                        code: e?.code,
                    });
                    console.error(
                        "[handoff][poll] payload snapshot:",
                        JSON.stringify(handoff?.payload || {}, null, 2)
                    );
                }
            }
        }



        // 🔵 BURAYA: assistant cevabını logla
        try {
            await logChatMessage({
                brandKey,
                threadId,
                role: "assistant",
                text: cleanText,
                rawText: accTextOriginal,
                handoff,
                visitorId,
                sessionId,
                source,
                meta,
                rawText: rawAssistantText,      // burada zaten fence'ler temizlenmiş metin var

            });
        } catch (e) {
            console.error("[db] logChatMessage (poll assistant) error:", e);
        }

        return res.json({
            status: "ok",
            threadId,
            message: cleanText || "(Yanıt metni bulunamadı)",
            handoff: handoff ? { kind: handoff.kind } : null
        });


    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "message_failed", detail: String(e) });
    }
});

export default router;
