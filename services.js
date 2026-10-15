// ============================================================================
// services.js - 音頻工具、本地評分引擎、OpenRouter API (GLM 5.3 + TTS) 及報告生成
// ============================================================================

window.CLS_SERVICES = {
    // 1. 將原始 16-bit PCM 音頻封裝為標準 WAV Blob
    pcmToWavBlob(pcmArrayBuffer, sampleRate = 24000, numChannels = 1) {
        const pcmBytes = new Uint8Array(pcmArrayBuffer);
        const wavHeader = new ArrayBuffer(44);
        const view = new DataView(wavHeader);
        const writeStr = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };
        const byteRate = sampleRate * numChannels * 2;
        const blockAlign = numChannels * 2;

        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + pcmBytes.byteLength, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeStr(36, 'data');
        view.setUint32(40, pcmBytes.byteLength, true);

        return new Blob([wavHeader, pcmBytes], { type: 'audio/wav' });
    },

    // 2. 將 Blob 轉為 Base64 Data URL 供管理員打包離線語音 JSON
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    },

    // 3. 離線備援規則評分引擎
    evaluateTranslationQualityLocal(userInput, targetText, langDirection) {
        const inputClean = (userInput || "").trim();
        const targetClean = (targetText || "").trim();
        
        if (!inputClean) {
            return {
                engine: "local",
                scores: { accuracy: 1.0, tone: 1.0, legal: 1.0, delivery: 1.0, overall: 1.0 },
                strengths: ["無 (None)"],
                improvements: ["學員未有作答。請務必進行口譯。 (No input detected. Please provide your interpretation.)"]
            };
        }

        let strengths = [];
        let improvements = [];
        
        const inputLen = inputClean.length;
        const targetLen = targetClean.length;
        const lengthRatio = inputLen / targetLen;

        let overlapRatio = 0;
        if (langDirection === "en-to-zh") {
            const inputChars = new Set([...inputClean.replace(/[\s,，。！?？\.「」『』]/g, "")]);
            const targetChars = [...targetClean.replace(/[\s,，。！?？\.「」『』]/g, "")];
            let matchedChars = 0;
            targetChars.forEach(char => {
                if (inputChars.has(char)) matchedChars++;
            });
            overlapRatio = targetChars.length ? (matchedChars / targetChars.length) : 0;
        } else {
            const inputWords = new Set((inputClean.toLowerCase().match(/\b\w+\b/g) || []));
            const targetWords = (targetClean.toLowerCase().match(/\b\w+\b/g) || []);
            let matchedWords = 0;
            targetWords.forEach(word => {
                if (inputWords.has(word)) matchedWords++;
            });
            overlapRatio = targetWords.length ? (matchedWords / targetWords.length) : 0;
        }

        let accuracy = 1.0 + (overlapRatio * 3.5);
        let tone = 1.0 + (overlapRatio * 3.2);
        let legal = 1.0 + (overlapRatio * 3.0);
        let delivery = lengthRatio >= 0.75 && lengthRatio <= 1.3 ? 4.7 : (lengthRatio < 0.5 ? 2.5 : 3.6);

        if (lengthRatio < 0.4) {
            accuracy -= 1.2; tone -= 1.0; legal -= 1.0;
            improvements.push("譯文長度嚴重不足。請確保將原聲陳述的所有實質性事實、細節全數譯出。");
        } else if (lengthRatio > 1.6) {
            delivery -= 1.2;
            improvements.push("譯文存在冗餘或贅述（Garrulous Interpretation）。法庭傳譯應追求精練準確，避免過度解說。");
        }

        if (langDirection === "en-to-zh") {
            const hasLegalPrefix = /向.*指出|指出|提出/.test(inputClean);
            const targetHasPrefix = /向.*指出|指出|提出/.test(targetClean);
            if (targetHasPrefix && !hasLegalPrefix) {
                legal -= 1.0;
                improvements.push("漏譯交叉盤問要件語：原聲包含律師盤問格式語，應譯出『我向你指出/提出 (I suggest/put it to you)』。");
            } else if (hasLegalPrefix) {
                legal += 0.4;
                strengths.push("精準捕捉並還原了英美法系交叉盤問（Cross-examination）的核心法律格式語。");
            }

            const hasColloquialParticles = /[囉嘛啫㗎啦吖]/.test(inputClean);
            const targetHasColloquial = /[囉嘛啫㗎啦吖]/.test(targetClean);
            if (targetHasColloquial && !hasColloquialParticles) {
                tone -= 0.6;
                improvements.push("譯文法律修辭正確，但遺漏了證人原供詞中的香港口語助詞（囉/嘛/啫），建構情感原貌略嫌僵化。");
            } else if (hasColloquialParticles) {
                tone += 0.3;
                strengths.push("成功傳神保留香港地道供詞特徵（Modal Particles），貼合證言事實原貌原則。");
            }
        } else {
            const lowerInput = inputClean.toLowerCase();
            const hasEnglishPrefix = /\b(suggest|put\s+it\s+to\s+you|challenge|assert|seriously\s+tell)\b/.test(lowerInput);
            const targetHasEnglishPrefix = /\b(suggest|put\s+it\s+to\s+you|challenge|assert|seriously\s+tell)\b/.test(targetClean.toLowerCase());
            
            if (targetHasEnglishPrefix && !hasEnglishPrefix) {
                legal -= 1.0;
                improvements.push("Missing foundational common-law defense/prosecution framing words (e.g., 'I suggest to you that...').");
            } else if (hasEnglishPrefix) {
                legal += 0.4;
                strengths.push("Excellent appropriation of adversarial legal discourse markers inside common-law settings.");
            }

            const targetHasPast = /\b(was|were|did|had|went|said|saw|felt|squeezed|pushed|obstructed|fabricated)\b/i.test(targetClean);
            const inputHasPast = /\b(was|were|did|had|went|said|saw|felt|squeezed|pushed|obstructed|fabricated|ed)\b/i.test(lowerInput);
            if (targetHasPast && !inputHasPast) {
                accuracy -= 0.6;
                improvements.push("請注意【案發時態合規性】：案情事實屬過去發生的歷史事實（Past facts），傳譯動詞應嚴格使用過去式。");
            } else if (inputHasPast) {
                strengths.push("時態（Tense Verification）處理妥當，精準鎖定案發現場時間線屬性。");
            }
        }

        const targetNumbers = targetClean.match(/\d+/g);
        if (targetNumbers) {
            let missingNum = false;
            targetNumbers.forEach(num => {
                if (!inputClean.includes(num)) missingNum = true;
            });
            if (missingNum) {
                accuracy -= 1.0;
                legal -= 0.5;
                improvements.push("⚠️ 嚴重警告：漏譯案情關鍵核心數字（如距離、時間、次數）。在司法定罪評估中，數字出錯屬於嚴重失實。");
            }
        }

        accuracy = Math.max(1.0, Math.min(5.0, Number(accuracy.toFixed(1))));
        tone = Math.max(1.0, Math.min(5.0, Number(tone.toFixed(1))));
        legal = Math.max(1.0, Math.min(5.0, Number(legal.toFixed(1))));
        delivery = Math.max(1.0, Math.min(5.0, Number(delivery.toFixed(1))));
        
        if (inputLen < 6) {
            accuracy = Math.min(accuracy, 1.5);
            tone = Math.min(tone, 1.5);
            legal = Math.min(legal, 1.5);
            delivery = Math.min(delivery, 1.5);
            improvements = ["輸入長度嚴重殘缺，無法進行司法核證評估 (Input too short for evaluation)。"];
        }

        if (strengths.length === 0) strengths.push("譯文語意大體對位，完成了基礎事實框架的搭建。");
        if (improvements.length === 0) improvements.push("口譯表現高度契合司法標準！請繼續保持此字斟句酌的核證水平。");

        const overall = Number(((accuracy + tone + legal + delivery) / 4).toFixed(1));

        return {
            engine: "local",
            scores: { accuracy, tone, legal, delivery, overall },
            strengths,
            improvements
        };
    },

    // 4. OpenRouter TTS 真人語音合成請求
    async requestOpenRouterTTSBlob(text, langCode, speakerRole, apiToUse, selectedModel) {
        const isCantonese = langCode === "zh-HK";
        let requestBody = {
            model: selectedModel,
            input: text,
            response_format: "mp3"
        };

        if (selectedModel === "fish-audio/drama-3") {
            const directionTag = isCantonese
                ? "[natural Hong Kong Cantonese speaker, emotional courtroom witness tone] "
                : "[assertive, formal Hong Kong courtroom counsel speaking British-accented legal English] ";
            requestBody.input = directionTag + text;
        } else if (selectedModel.startsWith("elevenlabs/")) {
            requestBody.voice = speakerRole === "questioner" ? "george" : "lily";
        } else if (selectedModel.startsWith("openai/")) {
            requestBody.voice = speakerRole === "questioner" ? "onyx" : "nova";
            requestBody.instructions = isCantonese
                ? "Speak in authentic, natural Hong Kong Cantonese (廣東話) with realistic courtroom witness emotion and colloquial tone."
                : "Speak in a formal, assertive common-law courtroom barrister tone.";
        }

        const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiToUse}`,
                "Content-Type": "application/json",
                "HTTP-Referer": window.location.href || "https://augustinehk.github.io/CLS-AI/",
                "X-Title": "Court Interpreter AI Suite (CLS)"
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter TTS HTTP ${response.status}: ${errText}`);
        }

        const contentType = response.headers.get("Content-Type") || "audio/mpeg";
        const arrayBuffer = await response.arrayBuffer();

        if (contentType.includes("audio/pcm")) {
            const rateMatch = contentType.match(/rate=(\d+)/);
            const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
            return this.pcmToWavBlob(arrayBuffer, sampleRate, 1);
        } else {
            return new Blob([arrayBuffer], { type: contentType });
        }
    },

    // 5. OpenRouter GLM 5.3 Flash 語意核證點評 API
    async evaluateWithGLM(answer, turnData, apiToUse) {
        const isEnSource = turnData.lang === "en-US";
        const sourceText = isEnSource ? turnData.text_en : turnData.text_zh;
        const targetText = isEnSource ? turnData.targetText_zh : turnData.targetText_en;

        const evalSystemPrompt = `You are a Principal Court Interpreter Assessor for the Court Language Section (法庭語文組 CLS) of the Hong Kong Judiciary.
Evaluate the trainee's court interpretation strictly according to Hong Kong judicial interpreting standards.

ASSESSMENT CRITERIA (Score 1.0 to 5.0 each, 1 decimal place):
1. "accuracy" (準確度): Completeness of factual details, numbers, dates, physical actions, and exact meaning without omission, addition, or distortion. Accept valid synonyms and natural equivalent phrasing.
2. "tone" (忠實度與語氣): Preservation of register, witness emotion, Hong Kong Cantonese colloquialisms/slang (e.g., 老爆, 睇水, 砌生豬肉, 抽水, 打龍通, 大石砸死蟹) or counsel's assertive demeanour.
3. "legal" (法律合規性): Correct use of adversarial courtroom framing (e.g., "I put it to you that..." <-> "我向你指出...", "I suggest to you..." <-> "我向你提出/指出..."), legal terminology, and strict past tense compliance for historical case facts.
4. "delivery" (流暢與精練度): Conciseness, natural syntax, and absence of garrulousness or fragmented sentences.

Provide your feedback in Traditional Chinese (Hong Kong judicial style) with specific examples from the trainee's input.
Return ONLY valid JSON matching this exact schema:
{
  "scores": {
    "accuracy": 4.5,
    "tone": 4.0,
    "legal": 4.5,
    "delivery": 4.2,
    "overall": 4.3
  },
  "strengths": ["具體優點 1", "具體優點 2"],
  "improvements": ["具體改善建議 1", "具體改善建議 2"]
}`;

        const userPrompt = `Direction: ${isEnSource ? "English Counsel Question -> Cantonese Interpretation" : "Cantonese Witness/Defendant Statement -> English Interpretation"}
Speaker Role: ${turnData.role_zh} (${turnData.role_en})
Original Court Statement: "${sourceText}"
Suggested Judicial Reference Translation: "${targetText}"
Trainee's Interpretation Input: "${answer}"

Evaluate the trainee's input and return the JSON assessment now.`;

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiToUse}`,
                "Content-Type": "application/json",
                "HTTP-Referer": window.location.href || "https://augustinehk.github.io/CLS-AI/",
                "X-Title": "Court Interpreter AI Suite (CLS)"
            },
            body: JSON.stringify({
                model: "z-ai/glm-5.3-flash",
                messages: [
                    { role: "system", content: evalSystemPrompt },
                    { role: "user", content: userPrompt }
                ],
                response_format: { type: "json_object" },
                temperature: 0.2
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter Grading Error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const rawContent = data.choices?.[0]?.message?.content;
        if (!rawContent) throw new Error("Empty response from GLM 5.3 Flash");

        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        const cleanJson = jsonMatch ? jsonMatch[0] : rawContent.replace(/[`]{3}(json)?/gi, "").trim();
        const parsed = JSON.parse(cleanJson);

        const acc = Math.max(1.0, Math.min(5.0, Number(parsed.scores?.accuracy || 3.0)));
        const ton = Math.max(1.0, Math.min(5.0, Number(parsed.scores?.tone || 3.0)));
        const leg = Math.max(1.0, Math.min(5.0, Number(parsed.scores?.legal || 3.0)));
        const del = Math.max(1.0, Math.min(5.0, Number(parsed.scores?.delivery || 3.0)));
        const ovr = Number(((acc + ton + leg + del) / 4).toFixed(1));

        return {
            engine: "glm-5.3-flash",
            scores: {
                accuracy: Number(acc.toFixed(1)),
                tone: Number(ton.toFixed(1)),
                legal: Number(leg.toFixed(1)),
                delivery: Number(del.toFixed(1)),
                overall: ovr
            },
            strengths: Array.isArray(parsed.strengths) && parsed.strengths.length > 0 ? parsed.strengths : ["語意傳達大致準確。"],
            improvements: Array.isArray(parsed.improvements) && parsed.improvements.length > 0 ? parsed.improvements : ["表現良好，可繼續保持。"]
        };
    },

    // 6. OpenRouter GLM 5.3 Flash 20輪自訂案件生成 API
    async generateCaseWithGLM(customBriefText, saveToCategory, apiToUse) {
        const systemPrompt = `You are a Principal Legal Translation Trainer for the Court Language Section (法庭語文組 CLS) of the Hong Kong Judiciary, specializing in creating high-stakes Court Liaison Interpreting assessment suites.
Your objective is to ingest the provided raw Case Fact Brief and dynamically construct an immersive, highly realistic, and progressive 20-turn adversarial courtroom dialogue.

STRICT DIALECT & REGULATED PHRASEOLOGY RULES:
1. English Questioning Turns (Odd Numbers: 1, 3, 5...): Spoken strictly by the Prosecutor or Defense Counsel. Tone must be assertive, adversarial, and formal. You MUST heavily infuse standard Hong Kong cross-examination formulae.
2. Cantonese Witness/Defendant Turns (Even Numbers: 2, 4, 6...): Spoken by the Witness, Victim, or Defendant. Must use natural, highly idiomatic, street-authentic Hong Kong Cantonese (zh-HK).

STRICT DATA MAP MATRIX RULES:
- Generate EXACTLY 20 consecutive steps (Turns 1 to 20). No truncation.
- For Odd Turns (en-US): "text_en" contains the lawyer's English question. "targetText_zh" contains the highly accurate judicial-standard Cantonese translation. "text_zh" and "targetText_en" must be kept identical to "text_en".
- For Even Turns (zh-HK): "text_zh" contains the speaker's Cantonese response. "targetText_en" contains the precise, professional legal English translation. "text_en" and "targetText_zh" must be kept identical to "text_zh".
- Return ONLY raw, valid JSON without markdown code block wrappers.

OUTPUT MATRIX JSON SCHEMA:
{
  "title_zh": "自訂 ➜ [Title in Chinese]",
  "title_en": "Custom ➜ [Title in English]",
  "desc_zh": "[Summary in Chinese]",
  "desc_en": "[Summary in English]",
  "dialogue": [
    {
      "turn": 1,
      "role_zh": "主控官",
      "role_en": "Prosecutor",
      "lang": "en-US",
      "text_zh": "English question",
      "text_en": "English question",
      "targetText_zh": "Cantonese translation",
      "targetText_en": "English question"
    }
  ]
}`;

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiToUse}`,
                "Content-Type": "application/json",
                "HTTP-Referer": window.location.href || "https://augustinehk.github.io/CLS-AI/",
                "X-Title": "Court Interpreter AI Suite (CLS)"
            },
            body: JSON.stringify({
                model: "z-ai/glm-5.3-flash",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Case Fact Brief:\n${customBriefText}\n\nGenerate the full 20-turn JSON now based strictly on the system instructions.` }
                ],
                response_format: { type: "json_object" },
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API failed (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const rawJsonText = data.choices?.[0]?.message?.content;
        if (!rawJsonText) throw new Error("Empty response from GLM 5.3 Flash");

        const jsonMatch = rawJsonText.match(/\{[\s\S]*\}/);
        const cleanJson = jsonMatch ? jsonMatch[0] : rawJsonText.replace(/[`]{3}(json)?/gi, "").trim();
        const parsed = JSON.parse(cleanJson);

        if (!parsed.dialogue || !Array.isArray(parsed.dialogue)) {
            throw new Error("Invalid dialogue array in returned JSON");
        }

        return {
            id: "custom_" + Date.now(),
            title_zh: parsed.title_zh || "自訂 ➜ GLM 生成模擬審訊案",
            title_en: parsed.title_en || "Custom ➜ GLM Generated Mock Trial",
            category: saveToCategory,
            desc_zh: parsed.desc_zh || "由 GLM 5.3 Flash 自動生成的 20 輪法庭雙向傳譯練習。",
            desc_en: parsed.desc_en || "20-turn courtroom liaison interpreting exercise generated by GLM 5.3 Flash.",
            dialogue: parsed.dialogue
        };
    },

    // 7. 離線模擬試題生成器 (無 API Key 時備援)
    generateLocalMockCase(customBriefText, saveToCategory) {
        const detectedLocations = customBriefText.match(/(旺角|尖沙咀|銅鑼灣|大圍|荃灣|沙田)/g) || ["旺角"];
        const location = detectedLocations[0];
        const detectedKeywords = customBriefText.match(/(非禮|打|踩|摸|太空油|毒品|合約|借據)/g) || ["非禮及襲擊"];
        const incident = detectedKeywords[0];

        return {
            id: "custom_" + Date.now(),
            title_zh: `自訂 ➜ 模擬${location}大樓${incident}審訊案`,
            title_en: `Custom ➜ Mock ${location} Building ${incident === '非禮' ? 'Indecent Assault' : 'Assault'} Trial`,
            category: saveToCategory,
            desc_zh: `自動根據導入案情要素生成的 10 輪對抗式中英雙向交替口譯考卷。`,
            desc_en: `Automatically assembled 10-turn court liaison simulation based on loaded details.`,
            dialogue: [
                { turn: 1, role_zh: "主控官", role_en: "Prosecutor", lang: "en-US", text_zh: `Mr. Chan, I suggest to you that you were present at the corridor in ${location} at approximately 9:30 p.m., correct?`, text_en: `Mr. Chan, I suggest to you that you were present at the corridor in ${location} at approximately 9:30 p.m., correct?`, targetText_zh: `陳先生，我向你指出，你喺大約夜晚九點半嘅時候，出現喺${location}嘅走廊通道，係咪？`, targetText_en: `Mr. Chan, I suggest to you that you were present at the corridor in ${location} at approximately 9:30 p.m., correct?` },
                { turn: 2, role_zh: "事主 / 證人", role_en: "Witness", lang: "zh-HK", text_zh: "我當時行得好急去搭車，根本無留意到邊個企喺我左後方囉！", text_en: "I was walking very hastily to take transport, I didn't notice at all who was standing behind my left rear!", targetText_zh: "我當時行得好急去搭車，根本無留意到邊個企喺我左後方囉！", targetText_en: "I was walking very hastily to catch the train, and did not pay any attention at all to who was standing at my left rear!" },
                { turn: 3, role_zh: "主控官", role_en: "Prosecutor", lang: "en-US", text_zh: "The victim felt a physical pressure on her intimate part. What was your arm position at that moment?", text_en: "The victim felt a physical pressure on her intimate part. What was your arm position at that moment?", targetText_zh: "受害人當時感覺到佢嘅敏感部位受到身體壓迫。你當時對手喺咩位置？", targetText_en: "The victim felt a physical pressure on her intimate part. What was your arm position at that moment?" },
                { turn: 4, role_zh: "事主 / 證人", role_en: "Witness", lang: "zh-HK", text_zh: "我兩隻手都拎住嘢，一邊夾住胳肋底，點會有手去非禮佢呢？！", text_en: "Both of my hands were carrying things, with one side tucked under my armpit, how could I have an extra hand to indecently assault her?!", targetText_zh: "我兩隻手都拎住嘢，一邊夾住胳肋底，點會有手去非禮佢呢？！", targetText_en: "Both of my hands were holding things, with one tucked under my armpit, how could I have a free hand to indecently assault her?!" },
                { turn: 5, role_zh: "主控官", role_en: "Prosecutor", lang: "en-US", text_zh: "After she confronted you, did you yell, 'Do you believe I will hit you' in an angry tone?", text_en: "After she confronted you, did you yell, 'Do you believe I will hit you' in an angry tone?", targetText_zh: "喺佢同你理論之後，你係咪好憤怒噉對佢大叫「你信唔信我打你」？", targetText_en: "After she confronted you, did you yell, 'Do you believe I will hit you' in an angry tone?" },
                { turn: 6, role_zh: "事主 / 證人", role_en: "Witness", lang: "zh-HK", text_zh: "我只係一時衝口而出，因為佢無端端踩我鞋踭、仲大聲屈我摸佢籮柚！", text_en: "I only blurted it out impulsively, because she accidentally stepped on the back of my shoes for no reason and loudly framed me for touching her bottom!", targetText_zh: "我只係一時衝口而出，因為佢無端端踩我鞋踭、仲大聲屈我摸佢籮柚！", targetText_en: "I only blurted it out in a moment of anger, because she stepped on my shoe back for no reason and loudly accused me of touching her buttocks!" },
                { turn: 7, role_zh: "辯方大律師", role_en: "Defense Counsel", lang: "en-US", text_zh: "I suggest that the allegation of indecent assault was entirely fabricated to vent your anger over the queue dispute.", text_en: "I suggest that the allegation of indecent assault was entirely fabricated to vent your anger over the queue dispute.", targetText_zh: "我向你指出，非禮嘅指控完全係你捏造出嚟，純粹係為咗發洩你對排隊糾紛嘅不滿。 ", targetText_en: "I suggest that the allegation of indecent assault was entirely fabricated to vent your anger over the queue dispute." },
                { turn: 8, role_zh: "事主 / 證人", role_en: "Witness", lang: "zh-HK", text_zh: "我絕對唔同意。我事後即刻報告地鐵職員，有晒閉路電視，我唔會拿清白講笑！", text_en: "I absolutely disagree. I reported to the MTR staff immediately afterwards, there's CCTV everywhere, I won't joke with my innocence!", targetText_zh: "我絕對唔同意。我事後即刻報告地鐵職員，有晒閉路電視，我唔會拿清白講笑！", targetText_en: "I absolutely disagree. I reported the matter to MTR staff immediately afterwards, there was CCTV, and I would not joke with my reputation!" },
                { turn: 9, role_zh: "辯方大律師", role_en: "Defense Counsel", lang: "en-US", text_zh: "Under the guidelines, any body contact through clothing can still be highly ambiguous. Is it possible it was just a normal brush?", text_en: "Under the guidelines, any body contact through clothing can still be highly ambiguous. Is it possible it was just a normal brush?", targetText_zh: "喺相關指引下，隔住衣物嘅身體接觸都可以好模糊。當時係咪有可能只係普通擦過？", targetText_en: "Under the guidelines, any body contact through clothing can still be highly ambiguous. Is it possible it was just a normal brush?" },
                { turn: 10, role_zh: "事主 / 證人", role_en: "Witness", lang: "zh-HK", text_zh: "絕對唔係。個觸碰好大力，而且係揸咗幾下，點會係唔小心擦過？！", text_en: "Absolutely not. The touching was very forceful and it was squeezed several times, how could it be an accidental brush?!", targetText_zh: "絕對唔係。個觸碰好大力，而且係揸咗幾下，點會係唔小心擦過？！", targetText_en: "Absolutely not. The touch was very hard and it was squeezed several times, how could it be an accidental brush?!" }
            ]
        };
    },

    // 8. 開啟獨立 HTML 評核證書
    openHTMLReport({ currentCase, practiceTurnsLimit, aiEvaluations, userTranslations, traineeName, traineeId, isBlindMode }) {
        const reportTitle = "法庭語文組 (CLS) 培訓評核證書";
        const dateStr = new Date().toLocaleDateString("zh-HK", { year: 'numeric', month: 'long', day: 'numeric' });
        
        const activeDialogueSlice = currentCase.dialogue.slice(0, practiceTurnsLimit);
        let keyWarnings = [];

        const tableRowsHtml = activeDialogueSlice.map((turn) => {
            const evalResult = aiEvaluations[turn.turn];
            const studentAns = userTranslations[turn.turn] || "---";
            const isEnglishSource = turn.lang === "en-US";
            const targetText = isEnglishSource ? turn.targetText_zh : turn.targetText_en;
            const scores = evalResult ? evalResult.scores : { accuracy: "-", tone: "-", legal: "-", delivery: "-", overall: "-" };
            
            let highlightedStudentAns = studentAns;
            if (studentAns !== "---" && targetText) {
                if (studentAns.length < targetText.length * 0.4) {
                    highlightedStudentAns = `<span style="color: #dc2626; font-weight: bold; border-bottom: 2px dashed #dc2626;">${studentAns} (⚠️ 譯文嚴重殘缺)</span>`;
                    keyWarnings.push(`第 ${turn.turn} 題：譯文嚴重殘缺，未完整翻譯法庭原句。`);
                }
            }
            
            if (evalResult && evalResult.improvements.length > 0 && !evalResult.improvements[0].includes("表現高度契合")) {
                 if(keyWarnings.length < 2 && !keyWarnings[0]?.includes(`第 ${turn.turn} 題`)) {
                     keyWarnings.push(`第 ${turn.turn} 題：${evalResult.improvements[0]}`);
                 }
            }

            return `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 12px; font-weight: 600; color: #1e293b;">第 ${turn.turn} 步<br><span style="font-size: 11px; font-weight: normal; color: #64748b;">${turn.role_en} / ${turn.role_zh}</span></td>
                    <td style="padding: 12px; font-size: 13px; color: #334155;">${isEnglishSource ? turn.text_en : turn.text_zh}</td>
                    <td style="padding: 12px; font-size: 13px; color: #334155;">${highlightedStudentAns}</td>
                    <td style="padding: 12px; font-size: 13px; color: #059669; font-weight: 500;">${targetText}</td>
                    <td style="padding: 12px; font-weight: bold; color: #1e3a8a; text-align: center;">${scores.overall}</td>
                </tr>
            `;
        }).join("");
        
        const warningsHtml = keyWarnings.length > 0 
            ? `<div class="bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-lg mb-6">
                <h4 class="font-bold text-sm mb-2">🔍 重點改善建議 (Key Improvement Areas)</h4>
                <ul class="list-disc pl-5 text-sm">${keyWarnings.map(w => `<li>${w}</li>`).join('')}</ul>
               </div>`
            : '';

        const docHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>${reportTitle}</title>
                <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">
            </head>
            <body class="bg-gray-50 py-10 px-4 text-gray-900 font-sans">
                <div class="max-w-5xl mx-auto bg-white rounded-xl shadow-lg border border-gray-100 overflow-hidden">
                    <div class="bg-blue-900 text-white p-8 text-center relative">
                        <div class="text-xs uppercase tracking-widest text-amber-500 font-bold mb-1">Court Language Section (CLS)</div>
                        <h1 class="text-3xl font-extrabold mb-2">法庭語文組 ➜ 實戰口譯及 AI 核證能力評估報告</h1>
                        <p class="text-sm text-blue-200">Official Competency Evaluation & Quality Assurance Certificate</p>
                        <div class="absolute top-4 right-4 no-print">
                            <button onclick="window.print()" class="bg-amber-500 hover:bg-amber-600 text-blue-900 font-bold py-1.5 px-4 rounded text-xs transition duration-150">🖨️ 列印/下載 PDF</button>
                        </div>
                    </div>
                    <div class="p-8">
                        <div class="mb-6">
                            <h3 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4">📜 評核學員與案例資訊</h3>
                            <div class="grid grid-cols-2 gap-4 text-sm">
                                <div><span class="font-bold text-gray-600">學員姓名：</span> ${traineeName || "未填寫 (Anonymous)"}</div>
                                <div><span class="font-bold text-gray-600">職員/學員編號：</span> ${traineeId || "N/A"}</div>
                                <div><span class="font-bold text-gray-600">案件名稱：</span> ${currentCase.title_zh}</div>
                                <div><span class="font-bold text-gray-600">評核日期：</span> ${dateStr} (${isBlindMode ? "🎧 盲聽考核模式" : "📖 視聽練習模式"})</div>
                                <div class="col-span-2"><span class="font-bold text-gray-600">案例描述：</span> ${currentCase.desc_zh}</div>
                            </div>
                        </div>
                        ${warningsHtml}
                        <div class="mb-8">
                            <h3 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4">📋 評估清單 (共 ${activeDialogueSlice.length} 輪)</h3>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left border-collapse" style="font-size: 13px;">
                                    <thead>
                                        <tr class="bg-gray-100 text-gray-700">
                                            <th style="padding: 12px; width: 10%;">題號</th>
                                            <th style="padding: 12px; width: 30%;">法庭原聲 (Original)</th>
                                            <th style="padding: 12px; width: 30%;">您的傳譯 (Your Translation)</th>
                                            <th style="padding: 12px; width: 30%;">司法標準譯法 (Suggested)</th>
                                            <th style="padding: 12px; text-align: center; width: 10%;">得分</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${tableRowsHtml}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;

        const blob = new Blob([docHtml], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
    }
};