/**
 * Truncates code text to protect the model from context overflow (1,048,576 tokens limit)
 * Max 400,000 characters is approximately 100k - 130k tokens, which is extremely safe and generous.
 */
function truncateCode(text: string, maxCharacters = 400000): string {
  if (!text) return "";
  if (text.length <= maxCharacters) return text;
  return text.substring(0, maxCharacters) + "\n\n-- [!! WARNING: CODE TRUNCATED TO FIT CONTEXT CONSTRAINTS !!]\n-- [!! تم اقتطاع جزء من الكود لملاءمة حجم الذاكرة بالذكاء الاصطناعي !!]\n";
}

/**
 * Streams chunky data from server-side proxy or direct client-side API
 */
async function runStreamingProxyFetch(task: string, payload: any, onChunk: (text: string) => void): Promise<string> {
  const customBackend = localStorage.getItem("alzaabi_custom_backend") || "";
  const customApiKey = localStorage.getItem("alzaabi_custom_api_key") || "";

  // Helper to build prompt based on task
  const buildPrompt = () => {
    const code = payload.code || "";
    const originalCode = payload.originalCode || "";
    const type = payload.type || "";
    
    if (task === "analyze") {
      return `[ANALYSIS_PROTOCOL: STRICT_HIGH_FIDELITY_CODE_DEOBFUSCATION_AND_REBUILT]
ROLE: You are an expert code de-obfuscator, reverse engineer and logic restorer.
OBJECTIVE: Take the obfuscated target code and reconstruct it into clean, beautifully formatted, fully readable source code while maintaining 100% logic and operational parity.

CRITICAL PARITY PROTOCOL:
1. The output code MUST represent the EXACT logic, functions, mathematical calculations, API routes, network endpoints, visual interfaces, controls, structures, and behavior of the input files.
2. YOU ARE STRICTLY FORBIDDEN FROM HALLUCINATING or generating generic, standard, simulated, or template code "from your head". Do not write a generic script based on keyword association.
3. If some strings or functions appear highly obfuscated, unpack them semantically based on any available variable mappings, but do NOT replace them with placeholder comments. Every single structural block and line of logic must be faithfully reconstructed.
4. The output programming language MUST be the exact same programming language as the target input code (e.g., if target is Lua, output is Lua. If Javascript, output is Javascript. If Python, output is Python).

RECONSTRUCTION RULES:
- Rename all scrambled indices, single-character dummy letters, obf functions, and string arrays to clean human-readable names using clear naming conventions based on context.
- Inline, unpack, or decode arrays of encoded constant strings (Hex, Base64, arrays) back into clear variables or direct usages to make them transparently readable.
- Provide ONLY the final fully reconstructed clean code inside a clean markdown code block (e.g., \`\`\`lua ... \`\`\` or \`\`\`javascript ... \`\`\`).
- DO NOT write any report, markdown list, introductory note, explanation, bullet points, or friendly conversation. Provide ONLY the markdown code block.

ORIGINAL OBFUSCATED INPUT CODE (FOR REAL LOGIC):
${originalCode}

PRE-PROCESSED LAYER CODES (IF HELPFUL):
${code}

INPUT TYPE METHOD: ${type}`;
    } else if (task === "normalize") {
      return `[TASK: HUMAN_VARIABLES] Take the input code and rename scramble indices and generic letters to clean human-readable names. Preserve 100% original logical flows and functions. Write only the de-scrambled code block without discussion.\nINPUT:\n${code}`;
    } else if (task === "scan") {
      return `[TASK: SECURITY_VULNERABILITY_SCAN] Analyze the code for exploits, backdoors, standard flaws, hidden triggers, or dangerous logic. Provide risk levels and recommended mitigation actions. Write the report purely in Arabic markdown formatting. Keep the analysis thorough.\nINPUT CODE:\n${code}`;
    }
    return "";
  };

  // Option 1: Direct Client-Side Gemini API call (If API key is configured)
  if (customApiKey) {
    try {
      const prompt = buildPrompt();
      // Default to gemini-1.5-flash for client-side API (it's fast and highly capable)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${customApiKey}`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        let errJson;
        try { errJson = JSON.parse(errText); } catch { /* ignore */ }
        throw new Error(`Direct Gemini API Error: ${errJson?.error?.message || errText || response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Direct Gemini response stream is not readable.");
      }

      const decoder = new TextDecoder("utf-8");
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        // Parse individual JSON objects via Brace Counting
        let braceCount = 0;
        let startIdx = -1;
        let i = 0;
        while (i < buffer.length) {
          const char = buffer[i];
          if (char === '{') {
            if (braceCount === 0) {
              startIdx = i;
            }
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && startIdx !== -1) {
              const objStr = buffer.substring(startIdx, i + 1);
              try {
                const obj = JSON.parse(objStr);
                const textChunk = obj.candidates?.[0]?.content?.parts?.[0]?.text || "";
                if (textChunk) {
                  fullText += textChunk;
                  onChunk(fullText);
                }
              } catch (e) {
                // Not a full JSON or parsing error, continue buffering
              }
              buffer = buffer.substring(i + 1);
              i = -1; // restart search from 0 of the new buffer
              startIdx = -1;
            }
          }
          i++;
        }
      }
      return fullText;
    } catch (e: any) {
      console.error("Direct Gemini API error:", e);
      throw new Error(`[Direct API Error] ${e.message || e}`);
    }
  }

  // Option 2: Proxy API Call (Custom proxy backend or relative local host)
  const baseUrl = customBackend ? customBackend.replace(/\/$/, "") : "";
  const response = await fetch(`${baseUrl}/api/gemini/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, task })
  });

  if (!response.ok) {
    // If the endpoint returned 444, 404, or is on static Netlify host, explain gracefully.
    const isNetlify = window.location.hostname.includes("netlify.app");
    if ((response.status === 404 || isNetlify) && !customBackend) {
      throw new Error("سيرفر الذكاء الاصطناعي غير نشط على استضافة سكونية (Netlify). يرجى إدخال رابط السيرفر المخصص الخاص بك (مثل رابط Cloud Run) أو إدخال مفتاح Gemini API في لوحة الإعدادات لتفعيل خيارات الفك الذكي بالكامل وبدون مشاكل.");
    }
    const errText = await response.text();
    let errJson;
    try { errJson = JSON.parse(errText); } catch { /* ignore */ }
    throw new Error(errJson?.error || errText || "فشل الاتصال بسيرفر الذكاء الاصطناعي.");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("سيرفر الذكاء الاصطناعي لم يستجب بهيئة بث (ReadableStream).");
  }

  const decoder = new TextDecoder("utf-8");
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    fullText += chunkText;
    onChunk(fullText);
  }

  return fullText;
}

export async function analyzeCodeStream(code: string, originalCode: string, type: string, onChunk: (text: string) => void) {
  try {
    const safeOriginal = truncateCode(originalCode, 400000);
    const safeOutput = truncateCode(code, 400000);

    return await runStreamingProxyFetch("analyze", {
      code: safeOutput,
      originalCode: safeOriginal,
      type
    }, onChunk);
  } catch (error: any) {
    console.error("AI Analysis Error:", error);
    throw error;
  }
}

export async function normalizeVariablesStream(code: string, onChunk: (text: string) => void) {
  try {
    const safeOutput = truncateCode(code, 400000);
    return await runStreamingProxyFetch("normalize", { code: safeOutput }, onChunk);
  } catch (error: any) {
    console.error("Variable Normalization Error:", error);
    throw error;
  }
}

export async function scanVulnerabilitiesStream(code: string, onChunk: (text: string) => void) {
  try {
    const safeOutput = truncateCode(code, 400000);
    return await runStreamingProxyFetch("scan", { code: safeOutput }, onChunk);
  } catch (error: any) {
    console.error("Vulnerability Scan Error:", error);
    throw error;
  }
}
