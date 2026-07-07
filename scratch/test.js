const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
  try {
    const genAI = new GoogleGenerativeAI('AQ.Ab8RN6JYUyBeLTEpn87DhS******************');
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(['Hello']);
    console.log(result.response.text());
  } catch (err) {
    console.error("Gemini Error:", err.message);
  }
}

test();
