import { GoogleGenAI } from "@google/genai";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";

/**
 * Calculates age from date of birth.
 */
export const calculateAge = (dob) => {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : null;
};

/**
 * Formats height in cm and feet/inches (e.g. 175 cm (5'9")).
 */
export const formatHeight = (cm) => {
  if (!cm || typeof cm !== "number") return null;
  const totalInches = Math.round(cm / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${cm} cm (${feet}'${inches}")`;
};

/**
 * Converts enum keys (e.g., "never_married", "strictly_practising") to human-readable strings.
 */
const formatEnum = (val) => {
  if (!val || typeof val !== "string") return "";
  return val
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

/**
 * Formats full profile details collected from onboarding steps 4 through 20.
 */
export const formatProfileSummary = (user = {}, profile = {}) => {
  const accountType = profile.accountType || "individual";
  const profileFor = profile.profileFor;
  const isFamily = accountType === "family" && profileFor && profileFor !== "self";

  const fullName = user.fullName || "A seeker";
  const gender = profile.gender || user.gender || "unspecified";
  const age = calculateAge(profile.dateOfBirth);
  const religion = profile.religion ? formatEnum(profile.religion) : "Islam";
  const faith = profile.faith ? formatEnum(profile.faith) : "";
  const religiousPractice = profile.religiousPractice
    ? formatEnum(profile.religiousPractice)
    : "";

  const nationality = profile.nationality || "";
  const grewUpIn = profile.grewUpIn || "";
  const ethnicity = profile.ethnicity || "";
  const motherTongue = profile.motherTongue || "";
  const languages = Array.isArray(profile.languages) ? profile.languages.filter(Boolean) : [];

  const educationLevel = profile.educationLevel || "";
  const professionTitle = profile.professionTitle || "";
  const heightFormatted = formatHeight(profile.heightCm);
  const maritalStatus = profile.maritalStatus ? formatEnum(profile.maritalStatus) : "Never Married";

  const marriageTimeline = profile.marriageIntentions?.marriageTimeline
    ? formatEnum(profile.marriageIntentions.marriageTimeline)
    : "";
  const getToknowDuration = profile.marriageIntentions?.getToknowDuration
    ? formatEnum(profile.marriageIntentions.getToknowDuration)
    : "";

  const lifestyle = profile.lifestyle || {};
  const lifestyleItems = [];
  if (lifestyle.halalFood === true) lifestyleItems.push("Eats strictly Halal");
  if (lifestyle.smoking === false) lifestyleItems.push("Non-smoker");
  if (lifestyle.alcohol === false) lifestyleItems.push("Does not consume alcohol");

  const aboutYou = profile.aboutYou || {};
  const aboutYouItems = [];
  if (aboutYou.bornMuslim === true) aboutYouItems.push("Born Muslim");
  if (aboutYou.haveChildren === false) aboutYouItems.push("No children");
  else if (aboutYou.haveChildren === true) aboutYouItems.push("Has children");
  if (aboutYou.relocateAbroad === true) aboutYouItems.push("Open to relocating abroad");

  const personalityTraits = Array.isArray(profile.personalityTraits)
    ? profile.personalityTraits.filter(Boolean)
    : [];

  const rawInterests = profile.interests || {};
  const interestsList = [
    ...(Array.isArray(rawInterests.cultural) ? rawInterests.cultural : []),
    ...(Array.isArray(rawInterests.foodDrinks) ? rawInterests.foodDrinks : []),
    ...(Array.isArray(rawInterests.sports) ? rawInterests.sports : []),
    ...(Array.isArray(rawInterests.fashion) ? rawInterests.fashion : []),
    ...(Array.isArray(rawInterests.activities) ? rawInterests.activities : []),
  ].filter(Boolean);

  return {
    isFamily,
    accountType,
    profileFor,
    fullName,
    gender,
    age,
    religion,
    faith,
    religiousPractice,
    nationality,
    grewUpIn,
    ethnicity,
    motherTongue,
    languages,
    educationLevel,
    professionTitle,
    heightFormatted,
    maritalStatus,
    marriageTimeline,
    getToknowDuration,
    lifestyleItems,
    aboutYouItems,
    personalityTraits,
    interestsList,
  };
};

/**
 * Fallback generator that creates personalized, authentic Muslim matrimony bios
 * without needing an external API call if Gemini key is missing or quota exceeded.
 */
export const generateFallbackBios = (summary, { tone = "balanced", keywords = "" } = {}) => {
  const {
    isFamily,
    profileFor,
    fullName,
    gender,
    age,
    religion,
    religiousPractice,
    faith,
    nationality,
    grewUpIn,
    languages,
    educationLevel,
    professionTitle,
    maritalStatus,
    personalityTraits,
    interestsList,
    lifestyleItems,
    aboutYouItems,
    marriageTimeline,
  } = summary;

  const relationshipTitle = profileFor ? formatEnum(profileFor).toLowerCase() : "family member";
  const pronounSubject = gender === "female" ? "she" : "he";
  const pronounPossessive = gender === "female" ? "her" : "his";
  const pronounObject = gender === "female" ? "her" : "him";
  const CapPronounSubject = gender === "female" ? "She" : "He";
  const CapPronounPossessive = gender === "female" ? "Her" : "His";

  const traitsString = personalityTraits.length > 0 ? personalityTraits.slice(0, 3).join(", ") : "kind, grounded, and sincere";
  const interestsString = interestsList.length > 0 ? interestsList.slice(0, 3).join(", ") : "learning, spending time with family, and healthy living";
  const locationText = grewUpIn ? `grew up in ${grewUpIn}` : nationality ? `based in ${nationality}` : "";
  const careerText = professionTitle
    ? `working as a ${professionTitle}${educationLevel ? ` with a background in ${educationLevel}` : ""}`
    : educationLevel
      ? `educated in ${educationLevel}`
      : "";

  let balancedBio = "";
  let religiousBio = "";
  let conciseBio = "";

  if (isFamily) {
    // Written from family / guardian perspective
    balancedBio = `Assalamu Alaikum. On behalf of our family, I am creating this profile for my ${relationshipTitle}, ${fullName}. ${CapPronounSubject} is a ${age ? `${age}-year-old, ` : ""}${traitsString} individual ${careerText ? `who is currently ${careerText}` : ""}${locationText ? ` (${locationText})` : ""}. ${CapPronounSubject} maintains a strong balance between Islamic values and professional life. In ${pronounPossessive} personal time, ${pronounSubject} enjoys ${interestsString}. We are looking for a practicing, family-oriented partner who values mutual respect, companionship, and deen to build a blessed future together insha'Allah.`;

    religiousBio = `Assalamu Alaikum wa Rahmatullah. We are looking for a righteous, deen-conscious life partner for our ${relationshipTitle}, ${fullName}. ${CapPronounSubject} is ${religiousPractice ? `${religiousPractice.toLowerCase()}, ` : "actively practicing, "}${faith ? `focused on ${faith.toLowerCase()}, ` : ""}and prioritizes a halal lifestyle and Islamic etiquettes in daily life. Alongside strong moral character, ${pronounSubject} is ${careerText || "well-educated and responsible"}. We pray to find a kind, compatible partner who is serious about marriage according to the Quran and Sunnah.`;

    conciseBio = `Assalamu Alaikum. Profile created for my ${relationshipTitle}, ${fullName}${age ? ` (${age} yrs)` : ""}. ${CapPronounSubject} is ${careerText || "well-educated"}, ${traitsString}, and values a balanced Islamic lifestyle. Seeking a genuine, practicing partner for marriage${marriageTimeline ? ` (${marriageTimeline.toLowerCase()})` : ""}.`;
  } else {
    // Written in 1st person for self
    balancedBio = `Assalamu Alaikum! I am ${fullName}${age ? `, ${age} years old` : ""}${locationText ? `, ${locationText}` : ""}. I am currently ${careerText || "focused on my career and personal growth"}. Those close to me describe me as ${traitsString}. I value my faith and strive to keep a healthy balance between my professional aspirations and Islamic responsibilities. In my leisure time, I enjoy ${interestsString}. I am looking for a kind-hearted, sincere, and practicing partner who shares similar values to build a peaceful, loving home together insha'Allah.`;

    religiousBio = `Assalamu Alaikum wa Rahmatullah. My name is ${fullName}. In my life, faith and character come first. I consider myself ${religiousPractice ? religiousPractice.toLowerCase() : "actively practicing"} and strive to maintain a halal and disciplined lifestyle. Professionally, I am ${careerText || "settled and responsible"}. I am seeking a practicing Muslim spouse with good akhlaq, modesty, and family values—someone with whom I can support each other in both our deen and dunya.`;

    conciseBio = `Assalamu Alaikum. I am ${fullName}${age ? ` (${age})` : ""}, ${careerText || "professional"}. Described as ${traitsString}, I enjoy ${interestsString} and prioritize a halal, balanced lifestyle. Seeking a sincere, practicing partner for marriage${marriageTimeline ? ` within ${marriageTimeline.toLowerCase()}` : ""}.`;
  }

  if (keywords && keywords.trim()) {
    balancedBio += ` Note: ${keywords.trim()}`;
    religiousBio += ` Note: ${keywords.trim()}`;
    conciseBio += ` Note: ${keywords.trim()}`;
  }

  const options = [
    {
      tone: "balanced",
      title: "Balanced & Engaging",
      bio: balancedBio.trim(),
    },
    {
      tone: "religious",
      title: "Deen & Values Focused",
      bio: religiousBio.trim(),
    },
    {
      tone: "concise",
      title: "Short & Direct",
      bio: conciseBio.trim(),
    },
  ];

  const matched = options.find((o) => o.tone === tone) || options[0];

  return {
    bio: matched.bio,
    options,
    source: "heuristic",
  };
};

/**
 * Builds the AI prompt for Google Gemini based on all onboarding data (steps 4 to 20).
 */
const buildGeminiPrompt = (summary, { tone = "balanced", keywords = "" } = {}) => {
  return `You are an expert matrimonial bio copywriter for "Find A Nikah", a respectful, modern Islamic matrimony platform.
Your task is to write a warm, sincere, modest, and culturally refined matrimony profile bio (About Me) based on the user's profile data collected during onboarding.

### USER PROFILE DETAILS:
- Full Name: ${summary.fullName}
- Profile Created By: ${summary.isFamily ? `Family member on behalf of their ${summary.profileFor}` : "Self (Individual)"}
- Gender: ${summary.gender}
- Age: ${summary.age ? `${summary.age} years old` : "Not provided"}
- Religion & Practice: ${summary.religion} (${summary.religiousPractice || "Practicing"}${summary.faith ? `, Focus: ${summary.faith}` : ""})
- Nationality & Roots: ${summary.nationality || "Not specified"}${summary.grewUpIn ? ` (Grew up in: ${summary.grewUpIn})` : ""}${summary.ethnicity ? `, Ethnicity: ${summary.ethnicity}` : ""}
- Languages: ${summary.languages.length ? summary.languages.join(", ") : summary.motherTongue || "English"}
- Education: ${summary.educationLevel || "Educated"}
- Profession: ${summary.professionTitle || "Professional"}
- Height: ${summary.heightFormatted || "Not specified"}
- Marital Status: ${summary.maritalStatus}
- Lifestyle & Habits: ${summary.lifestyleItems.length ? summary.lifestyleItems.join(", ") : "Halal-conscious"}
- Background & Relocation: ${summary.aboutYouItems.length ? summary.aboutYouItems.join(", ") : "Muslim background"}
- Personality Traits: ${summary.personalityTraits.length ? summary.personalityTraits.join(", ") : "Kind, sincere, family-oriented"}
- Interests & Hobbies: ${summary.interestsList.length ? summary.interestsList.join(", ") : "Family time, personal development, healthy lifestyle"}
- Marriage Intentions: Timeline: ${summary.marriageTimeline || "Serious marriage"}, Get to know duration: ${summary.getToknowDuration || "Mutual understanding"}
${keywords ? `- Additional user notes/wishes to weave in: "${keywords}"` : ""}

### INSTRUCTIONS & GUIDELINES:
1. Perspective:
   - If created by a family member (profileCreatedBy is family): MUST be written in the 3rd person from the perspective of the parent or family member introducing their ${summary.profileFor || "relative"} (e.g., "Assalamu Alaikum. On behalf of our family, I am creating this profile for my ${summary.profileFor || "son"}...").
   - If created by Self: MUST be written in the 1st person ("Assalamu Alaikum! I am...").
2. Tone & Content:
   - Begin with an Islamic greeting ("Assalamu Alaikum" or "Assalamu Alaikum wa Rahmatullah").
   - Naturally blend career, education, deen, hobbies, and personality into cohesive, human prose. DO NOT make it read like a mechanical resume or list of bullet points.
   - Maintain Islamic modesty (Haya), warmth, and respect. No boastfulness, arrogance, or inappropriate slang.
   - Mention what kind of spouse they are seeking (e.g. practicing, kind-hearted, respectful, family-oriented).
   - Keep the length around 90-150 words per bio (under 1200 characters).
3. Provide three distinct variations:
   - Option 1 (balanced): Balanced, friendly, well-rounded covering profession, interests, and Islamic values.
   - Option 2 (religious): Deen & values focused, highlighting commitment to prayers, halal lifestyle, and religious compatibility.
   - Option 3 (concise): Short, direct, clear, and to the point.

### OUTPUT FORMAT:
Respond with ONLY valid JSON with no markdown wrapping, matching this exact structure:
{
  "bio": "<String: The primary bio for tone '${tone}'>",
  "options": [
    {
      "tone": "balanced",
      "title": "Balanced & Engaging",
      "bio": "<String>"
    },
    {
      "tone": "religious",
      "title": "Deen & Values Focused",
      "bio": "<String>"
    },
    {
      "tone": "concise",
      "title": "Short & Direct",
      "bio": "<String>"
    }
  ]
}`;
};

/**
 * Generates AI bio using Google Gemini GenAI SDK, with fallback to intelligent heuristic generator.
 */
export const generateBioFromProfileData = async (user, profile, options = {}) => {
  const summary = formatProfileSummary(user, profile);
  const tone = options.tone || "balanced";
  const keywords = options.keywords || "";

  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    // API key not set, return high quality fallback
    return generateFallbackBios(summary, { tone, keywords });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = buildGeminiPrompt(summary, { tone, keywords });
    const modelName = process.env.GEMINI_MODEL;

    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.7,
      },
    });

    const responseText = response.text || "";
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // In case the model wrapped it in markdown code fences
      const cleaned = responseText.replace(/```json\s*|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    }

    if (parsed && typeof parsed.bio === "string" && Array.isArray(parsed.options)) {
      return {
        bio: parsed.bio,
        options: parsed.options,
        source: "gemini",
        model: modelName,
      };
    }

    // If structure is unexpected, fallback
    return generateFallbackBios(summary, { tone, keywords });
  } catch (err) {
    // console.warn(`[Gemini AI Bio] Error generating bio via Gemini (${err.message}). Using fallback generator.`);
    return generateFallbackBios(summary, { tone, keywords });
  }
};

/**
 * Finds user and profile in MongoDB by userId, gathers all onboarding data,
 * and generates AI bio suggestions.
 */
export const generateAiBioForUser = async (userId, options = {}) => {
  const [user, profile] = await Promise.all([
    User.findById(userId),
    Profile.findOne({ userId }),
  ]);

  if (!user && !profile) {
    throw new Error("User profile not found");
  }

  return generateBioFromProfileData(user, profile, options);
};
