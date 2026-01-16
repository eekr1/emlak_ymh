
import { hasMinimumHandoffData } from "../services/handoff.js";

const validPayload = {
    contact: { name: "Test User", phone: "05551234567" },
    property_details: {
        transaction_type: "Satılık",
        property_type: "Konut",
        location: "İstanbul",
        budget: "5 Milyon"
    },
    request: { summary: "Ev lazım" }
};

const missingBudget = {
    contact: { name: "Test User", phone: "05551234567" },
    property_details: {
        transaction_type: "Satılık",
        property_type: "Konut",
        location: "İstanbul"
        // budget yok
    },
    request: { summary: "Ev lazım" }
};


console.log("--- Handoff Validation Test ---");
console.log("Valid Payload:", hasMinimumHandoffData(validPayload) ? "✅ PASS" : "❌ FAIL");
console.log("Missing Budget:", !hasMinimumHandoffData(missingBudget) ? "✅ PASS (Blocked)" : "❌ FAIL (Allowed)");
