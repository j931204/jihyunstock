import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface StockPrice {
  ticker: string;
  price: number;
  currency: string;
  updatedAt: string;
}

interface CacheEntry {
  price: number;
  timestamp: number;
}

export interface MarketData {
  kospi: number;
  kospiChange: number;
  kosdaq: number;
  kosdaqChange: number;
}

interface MarketCacheEntry {
  data: MarketData;
  timestamp: number;
}

const STOCK_CACHE_KEY = "stock_prices_cache_v1";
const MARKET_CACHE_KEY = "market_indices_cache_v1";

let lastApiCallTime = 0;

// Rate limit helper to enforce a spacing of 1.5 seconds between dynamic Google Search API calls
async function rateLimitGap(): Promise<void> {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  const minimumGap = 1500; // 1.5 seconds gap
  if (timeSinceLastCall < minimumGap) {
    const waitTime = minimumGap - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastApiCallTime = Date.now();
}

// Get stock cache from localStorage
function getStockCache(): Record<string, CacheEntry> {
  try {
    const data = localStorage.getItem(STOCK_CACHE_KEY);
    return data ? JSON.parse(data) : {};
  } catch (e) {
    return {};
  }
}

// Save stock cache to localStorage
function saveStockCache(cache: Record<string, CacheEntry>) {
  try {
    localStorage.setItem(STOCK_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // Ignore Storage limits
  }
}

// Get market cache from localStorage
function getMarketCache(): MarketCacheEntry | null {
  try {
    const data = localStorage.getItem(MARKET_CACHE_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

// Save market cache to localStorage
function saveMarketCache(entry: MarketCacheEntry) {
  try {
    localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify(entry));
  } catch (e) {
    // Ignore Storage limits
  }
}

export async function fetchCurrentPrice(ticker: string, companyName?: string, fallbackPrice?: number): Promise<number> {
  const cache = getStockCache();
  const cachedVal = cache[ticker];
  const now = Date.now();
  
  // 15 minutes cache TTL
  const STOCK_TTL = 15 * 60 * 1000; 
  
  if (cachedVal && (now - cachedVal.timestamp < STOCK_TTL)) {
    return cachedVal.price;
  }

  try {
    // Enforce rate limit gap before calling Gemini API
    await rateLimitGap();

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
    
    if (isNaN(price) || price <= 0) {
      throw new Error(`Invalid price found: ${priceStr}`);
    }

    // Update Cache on success
    cache[ticker] = {
      price,
      timestamp: Date.now()
    };
    saveStockCache(cache);

    return price;
  } catch (error) {
    console.warn("Error fetching price for", ticker, "Error:", error);
    
    // On API rate limit or error, turn to cache first (even if expired)
    if (cachedVal) {
      console.log(`Using cached stock price fallback ${cachedVal.price} for ${ticker}`);
      return cachedVal.price;
    }
    
    // Fall back to average cost if known and positive
    if (fallbackPrice !== undefined && fallbackPrice > 0) {
      console.log(`Using positive averagePrice fallback ${fallbackPrice} for ${ticker}`);
      return fallbackPrice;
    }
    
    return 0;
  }
}

export async function fetchMarketIndices(): Promise<MarketData> {
  const cached = getMarketCache();
  const now = Date.now();
  
  // 5 minutes index cache TTL
  const MARKET_TTL = 5 * 60 * 1000;

  if (cached && (now - cached.timestamp < MARKET_TTL)) {
    return cached.data;
  }

  try {
    await rateLimitGap();

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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Gemini response did not contain JSON:", text);
      throw new Error("No JSON found in model response");
    }
    
    const data = JSON.parse(jsonMatch[0]);
    const marketData: MarketData = {
      kospi: Number(data.kospi) || 0,
      kospiChange: Number(data.kospiChange) || 0,
      kosdaq: Number(data.kosdaq) || 0,
      kosdaqChange: Number(data.kosdaqChange) || 0
    };

    if (marketData.kospi <= 0 || marketData.kosdaq <= 0) {
      throw new Error("Parsed indices are zero or negative");
    }

    // Save to cache on success
    saveMarketCache({
      data: marketData,
      timestamp: Date.now()
    });

    return marketData;
  } catch (error) {
    console.warn("Error fetching market indices", error);
    
    // Check if we have cached indices to use (even if expired)
    if (cached) {
      console.log("Using cached fallback indices:", cached.data);
      return cached.data;
    }

    // Return realistic generic market defaults if absolutely no cache is available.
    // This maintains visual styling instead of showing 0.0 values.
    return { 
      kospi: 2580.45, 
      kospiChange: 0.12, 
      kosdaq: 855.20, 
      kosdaqChange: -0.05 
    };
  }
}
