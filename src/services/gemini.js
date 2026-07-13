import axios from "axios";

export const aiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

export const generateText = async (prompt) => {
  // gemini-flash-latest is Google's rolling alias for the current flash model,
  // so retired model ids (like gemini-2.0-flash) can't break us again.
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const { data } = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { timeout: 30000 }
  );
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
};

export const generateJson = async (prompt) => {
  const text = await generateText(prompt);
  const stripped = text.replace(/```json|```/g, "").trim();
  return JSON.parse(stripped);
};
