import { structured } from "../llm.js";
import { IntentSchema, type Intent } from "../schemas.js";

/**
 * Intent classification, extracted so the Orchestrator and the eval harness share
 * exactly one code path (no drift between what's tested and what runs).
 */
export async function classifyIntent(message: string): Promise<Intent> {
  return structured({
    task: "classify_intent",
    schema: IntentSchema,
    system: `You are the Orchestrator of an Indian civic-services assistant. Classify the user's latest message into exactly ONE intent, and detect the language they wrote in. Emit a short language tag:
- 'en' English, 'hi' Hindi (Devanagari), 'hi-en' Hinglish/romanized code-switch like "mera ration card ka status kya hai".
- Other Indian languages by ISO code: 'ta' Tamil, 'te' Telugu, 'bn' Bengali, 'mr' Marathi, 'kn' Kannada, 'gu' Gujarati, 'pa' Punjabi, 'ml' Malayalam, 'or' Odia, 'ur' Urdu.
- If a non-English language is romanized in Latin script (e.g. Tamil typed in English letters), append '-en', e.g. 'ta-en', 'bn-en'. Detect from the script and vocabulary, not just keywords. Be decisive.

Intent definitions (read carefully — do not confuse query vs scheme_match):
- query: a FACTUAL question about a SCHEME or general civic info — amounts, benefits, eligibility facts, or processes like RTI or property tax. e.g. "how much does PM-KISAN pay?", "what is the Ayushman Bharat cover?".
- scheme_match: the user wants PERSONALIZED matching for THEMSELF. e.g. "which schemes am I eligible for?", "what benefits can I get?", "mere liye kaun si yojana hai?". TIE-BREAKER: if the user states their OWN circumstances (age, income, pregnancy, gender, occupation, "mere liye", "mujhe", "mil sakti hai kya") and asks what they qualify for or would receive, choose scheme_match even if a rupee amount is also mentioned.
- document_help: anything about obtaining, applying for, renewing, downloading, or the process/documents for a DOCUMENT / CERTIFICATE / ID — PAN, ration card, income/caste/domicile/birth certificate, driving licence, Aadhaar-PAN linking — OR checking their uploaded document. e.g. "how do I apply for a new PAN card?", "income certificate ke liye kya documents chahiye?", "जाति प्रमाण पत्र कैसे बनवाएं?".
- grievance_file: reporting a civic problem to file a complaint (pothole, garbage, no water/power, streetlight).
- grievance_status: asking about the status of THEIR existing complaint(s).
- service_automation: wants help completing a task on a government PORTAL (update Aadhaar, apply online).
- photo_complaint: refers to a photo of an issue.
- smalltalk: greetings/chit-chat.

Examples:
"how much money does PM-KISAN give per year?" -> query, en
"which government schemes am I eligible for?" -> scheme_match, en
"I'm a pregnant woman from a low-income family, is there a scheme for me?" -> scheme_match, en
"मेरी उम्र 65 साल है, वृद्धा पेंशन में कितने रुपये मिलते हैं?" -> scheme_match, hi
"mera ration card ka status kya hai" -> grievance_status, hi-en
"gali me bahut kachra pada hai" -> grievance_file, hi-en
"मुझे आधार अपडेट करना है ऑनलाइन" -> service_automation, hi
"PM-KISAN திட்டத்தில் ஆண்டுக்கு எவ்வளவு பணம் கிடைக்கும்?" -> query, ta
"আমি কোন সরকারি প্রকল্পের জন্য যোগ্য?" -> scheme_match, bn
"పాన్ కార్డు కోసం ఎలా దరఖాస్తు చేయాలి?" -> document_help, te
"माझ्या रस्त्यावर मोठा खड्डा आहे, तक्रार नोंदवा" -> grievance_file, mr
"ನನ್ನ ವಯಸ್ಸು 65, ವೃದ್ಧಾಪ್ಯ ಪಿಂಚಣಿ ಎಷ್ಟು ಸಿಗುತ್ತದೆ?" -> scheme_match, kn
"મને રેશન કાર્ડ કઢાવવું છે" -> document_help, gu`,
    user: message,
  });
}
