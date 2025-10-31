import { ChatOpenAI } from '@langchain/openai';

const model = new ChatOpenAI({
  modelName: 'gpt-4o',
  temperature: 0.3,
  openAIApiKey: process.env.OPENAI_API_KEY
}).bind({
  response_format: {
    type: "json_object",
  },
});

/**
 * Generate competitor keywords based on a business's Google Maps info.
 *
 * @param {object} businessInfo - An object containing info about the business
 * @param {string} businessInfo.name - Business name
 * @param {string[]} businessInfo.types - Google Maps "types" array
 * @param {string} [businessInfo.description] - Optional: business description
 * @returns {Promise<string[]>} - List of suggested competitor keywords
 */
export async function generateCompetitorKeywords(businessInfo) {
  if (!businessInfo || !businessInfo.name || !businessInfo.types) {
    throw new Error('Invalid business info provided');
  }

  const prompt = `
Given the following business information from Google Maps:

- Name: ${businessInfo.name}
- Types: ${businessInfo.types.join(', ')}
${businessInfo.description ? `- Description: ${businessInfo.description}` : ''}

Generate a short list (3-5) of extremely relevant keywords that could be used to find direct competitors on Google Maps. Focus on very relevant terms someone would search for to find a similar business. Only return a JSON array of strings as 'keywords'.`;

  const response = await model.invoke(prompt);

  try {
    const keywords = JSON.parse(response.content).keywords;
    if (Array.isArray(keywords)) {
      return keywords;
    } else {
      throw new Error('Unexpected response format');
    }
  } catch (err) {
    console.error('Failed to parse GPT keywords:', err);
    return [];
  }
}
