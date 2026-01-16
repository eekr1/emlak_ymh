
// Mock process.env BEFORE import
process.env.HANDOFF_TO = "test@example.com";
process.env.EMAIL_FROM = "test@example.com";
process.env.EMAIL_FROM_NAME = "Test Bot";

// Mock env.js if needed (trick: we'll just handle the error or assume dotenv is dev dep)
// But better: since we are testing isolate function, let's fix the test runner environment.

// Actually the error is `Cannot find package 'dotenv'`. It seems `dotenv` is missing in node_modules.
// Let's just create a test that doesn't rely on config/env.js imports if possible,
// OR simply install dotenv. But since I can't easily install, I will trick the system or use existing deps.

// Better approach: Modify test_handoff.js to mocks logic without importing the real env.js if it causes issues.
// However `handoff.js` imports `../config/env.js`.
// Let's try to mock the module via simple patching or just ensure we run `npm install` if needed.
// But user said "dosyaları direk hukuk dosyasından kopyalayıp yapıştırdım", maybe node_modules are partial.

// Let's try to run `npm install` first? No, that might take time.
// Let's create a stand-alone version of the function for testing OR fix the import in test_handoff.js.
// Since `handoff.js` has imports at top level, they execute immediately.

// Let's try to just run `npm list dotenv` to see if it's there.
// If missing, I'll ask user or try to install it.
// Wait, I can just use `npm install dotenv` since I am allowed to run commands.

import { inferHandoffFromText } from "../services/handoff.js";

const testCases = [
    { text: "Satılık daire arıyorum", expected: "satılık" },
    { text: "Kiralık ev lazım", expected: "kiralık" },
    { text: "Arsa bakıyorum", expected: "arsa" },
    { text: "Dükkan devren", expected: "ticari" },
    { text: "Boşanma davası", expected: "diger" } // Should NOT match any real estate, defaults to 'diger' or 'Emlak Talebi' summary
];

console.log("--- Handoff Test Başlıyor ---");
testCases.forEach(t => {
    // Add contact info to force handoff generation
    const res = inferHandoffFromText(t.text + " \nİletişim: Test User, 05551234567");
    const cat = res?.payload?.matter?.category || "yok";
    console.log(`Input: "${t.text}" -> Kategori: ${cat} (Beklenen: ${t.expected})`);
});
console.log("--- Test Bitti ---");
