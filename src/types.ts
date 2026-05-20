import { Timestamp } from 'firebase/firestore';

export enum TradeType {
  BUY = 'BUY',
  SELL = 'SELL'
}

export interface Trade {
  id?: string;
  userId: string;
  ticker: string;
  companyName: string;
  type: TradeType;
  quantity: number;
  price: number;
  date: Date | Timestamp;
  reason: string;
  createdAt: Date | Timestamp;
}

export interface UserProfile {
  userId: string;
  displayName: string;
  totalDeposits: number;
  cashBalance: number;
  updatedAt: Date | Timestamp;
}

export interface PortfolioItem {
  ticker: string;
  companyName: string;
  quantity: number;
  averagePrice: number;
  currentPrice?: number;
  valuation?: number;
  gainLoss?: number;
  gainLossRate?: number;
}
