import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface StockPrice {
  ticker: string;
  price: number;
  currency: string;
  updatedAt: string;
}

export async function fetchCurrentPrice(ticker: string, companyName?: string): Promise<number> {
  try {
    const prompt = `Search for the most recent stock price for "${companyName || ''}" with ticker/symbol "${ticker}". 
    Look for results on Naver Finance (네이버 증권), Google Finance, or Yahoo Finance.
    
    IMPORTANT:
    1. Market detection: If it looks like a Korean stock (6 digits like 005930 or ETF codes like 394670), check Naver Finance (finance.naver.com).
    2. Precision: Find the exact current trading price (현재가) or the last closing price.
    3. Return only: The raw numeric value. No currency, no commas, no text.
    4. Handle variants: Sometimes tickers have suffixes (e.g., .KS, .KQ, or S suffix).
    
    Current ticker being searched: ${ticker}
    Current company hint: ${companyName}
    
    Example output: 25950`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const text = (response.text || "0").trim();
    const matches = text.match(/[\d.]+/);
    const priceStr = matches ? matches[0] : "0";
    const price = parseFloat(priceStr);
    
    return isNaN(price) ? 0 : price;
  } catch (error) {
    console.error("Error fetching price for", ticker, error);
    return 0;
  }
}

export async function fetchMarketIndices(): Promise<{ kospi: number; kosdaq: number; kospiChange: number; kosdaqChange: number }> {
  try {
    const prompt = `Find the current real-time index values and daily percentage changes for KOSPI and KOSDAQ.
    Return ONLY a JSON object in the following format:
    {"kospi": 2740.33, "kospiChange": 0.5, "kosdaq": 880.12, "kosdaqChange": -0.2}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const text = response.text || "{}";
    // Search for JSON block, handle potential markdown formatting
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Gemini response did not contain JSON:", text);
      throw new Error("No JSON found in model response");
    }
    
    const data = JSON.parse(jsonMatch[0]);
    return {
      kospi: Number(data.kospi) || 0,
      kospiChange: Number(data.kospiChange) || 0,
      kosdaq: Number(data.kosdaq) || 0,
      kosdaqChange: Number(data.kosdaqChange) || 0
    };
  } catch (error) {
    console.error("Error fetching market indices", error);
    return { kospi: 0, kospiChange: 0, kosdaq: 0, kosdaqChange: 0 };
  }
}
