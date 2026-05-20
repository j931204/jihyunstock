import React, { useState, useEffect, useMemo } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  setDoc, 
  doc, 
  getDoc,
  getDocs,
  orderBy,
  Timestamp,
  deleteDoc
} from 'firebase/firestore';
import { auth, db } from './lib/firebase';
import { Trade, TradeType, UserProfile, PortfolioItem, RealizedSaleItem } from './types';
import { formatCurrency, formatNumber, cn } from './lib/utils';
import { fetchCurrentPrice, fetchMarketIndices } from './services/geminiService';
import { 
  TrendingUp, 
  TrendingDown, 
  Plus, 
  Wallet, 
  BarChart3, 
  Clock, 
  MessageSquare,
  AlertCircle,
  Delete,
  Trash2,
  RefreshCcw,
  Loader2,
  Edit2,
  Globe,
  LogIn
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';

export default function App() {
  const [user] = useState({ uid: 'default-user', email: 'guest@stockmaster.app', displayName: 'Guest User' });
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPriceLoading, setIsPriceLoading] = useState(false);
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTrade, setEditingTrade] = useState<Trade | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [salesStartDate, setSalesStartDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [salesEndDate, setSalesEndDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [marketData, setMarketData] = useState({ kospi: 0, kosdaq: 0, kospiChange: 0, kosdaqChange: 0 });
  const [inputPassword, setInputPassword] = useState('');
  const [saveStatus, setSaveStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message?: string }>({ type: 'idle' });

  // Market indices sync
  useEffect(() => {
    const getIndices = async () => {
      const data = await fetchMarketIndices();
      setMarketData(data);
    };
    getIndices();
    const interval = setInterval(getIndices, 60000); // 1 minute
    return () => clearInterval(interval);
  }, []);

  // Price Syncing Function
  const syncAllPrices = async (force = false) => {
    if (portfolio.length === 0) return;
    setIsPriceLoading(true);
    const prices: Record<string, number> = force ? {} : { ...currentPrices };
    
    for (const item of portfolio) {
      if (force || !prices[item.ticker]) {
        const price = await fetchCurrentPrice(item.ticker, item.companyName, item.averagePrice);
        prices[item.ticker] = price;
      }
    }
    
    setCurrentPrices(prices);
    setIsPriceLoading(false);
  };

  // Load profile and trades once on mount
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const profileRef = doc(db, 'users', user.uid);
        const profileSnap = await getDoc(profileRef);
        
        let initialProfile: UserProfile;
        if (profileSnap.exists()) {
          initialProfile = profileSnap.data() as UserProfile;
          setProfile(initialProfile);
        } else {
          initialProfile = {
            userId: user.uid,
            displayName: user.displayName || 'User',
            totalDeposits: 0,
            cashBalance: 0,
            updatedAt: Timestamp.now()
          };
          await setDoc(profileRef, initialProfile);
          setProfile(initialProfile);
        }

        const tradesQuery = query(
          collection(db, 'trades'), 
          where('userId', '==', user.uid),
          orderBy('date', 'desc')
        );
        const tradesSnapshot = await getDocs(tradesQuery);
        const docs = tradesSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as Trade));
        setTrades(docs);
      } catch (e) {
        console.error("Error loading initial data from Firestore:", e);
      } finally {
        setLoading(false);
      }
    };

    loadInitialData();
  }, [user]);

  // Aggregate Portfolio
  const portfolio = useMemo(() => {
    const map = new Map<string, PortfolioItem>();
    
    // Filter trades by selected date
    const filteredTrades = trades.filter(t => {
      const tradeDate = t.date instanceof Timestamp ? t.date.toDate() : new Date(t.date);
      const limitDate = new Date(selectedDate);
      limitDate.setHours(23, 59, 59, 999);
      return tradeDate <= limitDate;
    });

    // Process trades chronologically
    const sortedTrades = [...filteredTrades].sort((a, b) => {
      const dateA = a.date instanceof Timestamp ? a.date.toMillis() : new Date(a.date).getTime();
      const dateB = b.date instanceof Timestamp ? b.date.toMillis() : new Date(b.date).getTime();
      return dateA - dateB;
    });

    sortedTrades.forEach(t => {
      const existing = map.get(t.ticker) || {
        ticker: t.ticker,
        companyName: t.companyName,
        quantity: 0,
        averagePrice: 0,
        totalCost: 0
      };

      if (t.type === TradeType.BUY) {
        const newQuantity = existing.quantity + t.quantity;
        const newTotalCost = (existing.quantity * existing.averagePrice) + (t.quantity * t.price);
        existing.quantity = newQuantity;
        existing.averagePrice = newTotalCost / newQuantity;
      } else {
        const newQuantity = Math.max(0, existing.quantity - t.quantity);
        // Selling doesn't change average price usually for simple tracking, just reduces quantity
        existing.quantity = newQuantity;
      }
      
      map.set(t.ticker, existing);
    });

    return Array.from(map.values()).filter(item => item.quantity > 0);
  }, [trades, selectedDate]);

  // Calculate Realized Sales (매도 종목 현황) 및 실현 손익
  const realizedSales = useMemo(() => {
    const map = new Map<string, { quantity: number; averagePrice: number }>();
    const sales: RealizedSaleItem[] = [];

    // Process trades chronologically to compute holding average cost at the moment of each sale
    const sortedTrades = [...trades].sort((a, b) => {
      const dateA = a.date instanceof Timestamp ? a.date.toMillis() : new Date(a.date).getTime();
      const dateB = b.date instanceof Timestamp ? b.date.toMillis() : new Date(b.date).getTime();
      return dateA - dateB;
    });

    // Parse start and end date limits
    const startLimit = new Date(salesStartDate);
    startLimit.setHours(0, 0, 0, 0);
    const endLimit = new Date(salesEndDate);
    endLimit.setHours(23, 59, 59, 999);

    sortedTrades.forEach(t => {
      const existing = map.get(t.ticker) || { quantity: 0, averagePrice: 0 };
      const tradeDate = t.date instanceof Timestamp ? t.date.toDate() : new Date(t.date);

      if (t.type === TradeType.BUY) {
        const newQuantity = existing.quantity + t.quantity;
        const newTotalCost = (existing.quantity * existing.averagePrice) + (t.quantity * t.price);
        existing.quantity = newQuantity;
        existing.averagePrice = newQuantity > 0 ? (newTotalCost / newQuantity) : 0;
        map.set(t.ticker, existing);
      } else {
        // SELL
        const avgPrice = existing.averagePrice;
        const totalSellAmount = t.price * t.quantity;
        const realizedProfitLoss = (t.price - avgPrice) * t.quantity;
        const returnRate = avgPrice > 0 ? ((t.price - avgPrice) / avgPrice) * 100 : 0;

        // Check if the sale date is within the selected range
        if (tradeDate >= startLimit && tradeDate <= endLimit) {
          sales.push({
            id: t.id || Math.random().toString(),
            ticker: t.ticker,
            companyName: t.companyName,
            averagePrice: avgPrice,
            sellPrice: t.price,
            quantity: t.quantity,
            totalSellAmount,
            realizedProfitLoss,
            returnRate,
            date: tradeDate
          });
        }

        // Reduce holding quantity, keep average cost same
        const newQuantity = Math.max(0, existing.quantity - t.quantity);
        existing.quantity = newQuantity;
        map.set(t.ticker, existing);
      }
    });

    // Sort by sale date, newest first
    return sales.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [trades, salesStartDate, salesEndDate]);

  // Sync current prices on portfolio change
  useEffect(() => {
    if (portfolio.length > 0 && Object.keys(currentPrices).length === 0) {
      syncAllPrices();
    }
  }, [portfolio]);

  const stats = useMemo(() => {
    const valuation = portfolio.reduce((acc, p) => {
      const price = currentPrices[p.ticker] || p.averagePrice;
      return acc + (p.quantity * price);
    }, 0);

    const cash = profile?.cashBalance || 0;
    const totalAssets = valuation + cash;
    const deposits = profile?.totalDeposits || 0;
    const totalSharesCount = portfolio.reduce((acc, p) => acc + p.quantity, 0);
    const returnRate = deposits > 0 ? ((totalAssets - deposits) / deposits) * 100 : 0;

    return {
      valuation,
      cash,
      totalAssets,
      deposits,
      totalSharesCount,
      returnRate
    };
  }, [portfolio, currentPrices, profile]);

  const handleUpdateBalances = (deposits: number, cash: number) => {
    if (!profile) return;
    setProfile({
      ...profile,
      totalDeposits: deposits,
      cashBalance: cash,
      updatedAt: Timestamp.now()
    });
  };

  const handleAddTrade = (trade: Partial<Trade>) => {
    if (!profile) return;

    if (editingTrade?.id) {
      // Revert old trade impact first
      const oldAmount = editingTrade.quantity * editingTrade.price;
      const revertedCash = editingTrade.type === TradeType.BUY 
        ? profile.cashBalance + oldAmount 
        : profile.cashBalance - oldAmount;
      
      const newAmount = (trade.quantity || 0) * (trade.price || 0);
      const finalCash = trade.type === TradeType.BUY 
        ? revertedCash - newAmount 
        : revertedCash + newAmount;
      
      setProfile({
        ...profile,
        cashBalance: finalCash,
        updatedAt: Timestamp.now()
      });

      setTrades(prev => prev.map(t => t.id === editingTrade.id ? {
        ...t,
        ...trade,
        updatedAt: Timestamp.now()
      } as Trade : t));
      setEditingTrade(null);
    } else {
      // Doc ID generator client-side
      const newTradeId = doc(collection(db, 'trades')).id;
      const newTrade: Trade = {
        ...trade,
        id: newTradeId,
        userId: user.uid,
        createdAt: Timestamp.now()
      } as Trade;

      setTrades(prev => [newTrade, ...prev]);
      
      // Update cash balance if it was a BUY or SELL
      const amount = (trade.quantity || 0) * (trade.price || 0);
      const newCash = trade.type === TradeType.BUY 
        ? profile.cashBalance - amount 
        : profile.cashBalance + amount;
      
      setProfile({
        ...profile,
        cashBalance: newCash,
        updatedAt: Timestamp.now()
      });
    }
    setShowAddForm(false);
  };

  const handleDeleteTrade = (id: string, trade: Trade) => {
    if (!confirm("이 기록을 삭제하시겠습니까?")) return;
    if (!profile) return;

    setTrades(prev => prev.filter(t => t.id !== id));

    // Revert cash balance
    const amount = (trade.quantity || 0) * (trade.price || 0);
    const newCash = trade.type === TradeType.BUY 
      ? profile.cashBalance + amount 
      : profile.cashBalance - amount;

    setProfile({
      ...profile,
      cashBalance: newCash,
      updatedAt: Timestamp.now()
    });
  };

  const handleSaveToServer = async () => {
    if (inputPassword !== '1121') {
      setSaveStatus({ type: 'error', message: '비밀번호가 올바르지 않습니다.' });
      return;
    }

    setSaveStatus({ type: 'loading' });

    try {
      // 1. Save local user profile
      if (profile) {
        const profileRef = doc(db, 'users', user.uid);
        await setDoc(profileRef, {
          ...profile,
          updatedAt: Timestamp.now()
        });
      }

      // 2. Fetch remote trade IDs to recognize deletions
      const tradesQuery = query(
        collection(db, 'trades'), 
        where('userId', '==', user.uid)
      );
      const remoteTradesSnapshot = await getDocs(tradesQuery);
      const remoteTradeIds = remoteTradesSnapshot.docs.map(d => d.id);

      // 3. Find deleted trade IDs
      const currentTradeIds = new Set(trades.map(t => t.id));
      const deletedIds = remoteTradeIds.filter(id => !currentTradeIds.has(id));

      // 4. Perform deletes
      for (const deleteId of deletedIds) {
        await deleteDoc(doc(db, 'trades', deleteId));
      }

      // 5. Save all current local trades (both updated and newly added)
      for (const trade of trades) {
        const tradeRef = doc(db, 'trades', trade.id);
        const { id, ...dataToSave } = trade; // setDoc without the nested metadata ID if preferred, but keeping ID is fine
        await setDoc(tradeRef, {
          id,
          ...dataToSave
        }, { merge: true });
      }

      setSaveStatus({ type: 'success', message: '데이터가 완벽하게 서버에 저장되었습니다! 어디서든 이 링크로 접속하면 현재 상태가 그대로 복구됩니다.' });
      setInputPassword(''); // clear input password
      
      // Auto-hide success message after 5 seconds
      setTimeout(() => {
        setSaveStatus(prev => prev.type === 'success' ? { type: 'idle' } : prev);
      }, 5000);

    } catch (error) {
      console.error('Error saving data to Firestore:', error);
      setSaveStatus({ type: 'error', message: '데이터 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  };

  // if (!user) {
  //   return <LoginView onLogin={signIn} />;
  // }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center font-mono">
        <Loader2 className="animate-spin mr-2" /> DATA LOADING...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F1F5F9] text-[#334155] font-sans overflow-hidden flex flex-col">
      {/* Header Area: Branding & Dashboard Summary */}
      <header className="bg-[#758c64] text-white p-6 shadow-lg z-50">
        <div className="flex justify-between items-end max-w-7xl mx-auto w-full">
          <div>
            <h1 className="text-xl font-bold tracking-tight opacity-90 uppercase">
              주식 매매 일지
            </h1>
          </div>
          <div className="flex space-x-12 items-end">
            <div className="text-right">
              <p className="text-xs opacity-70 uppercase font-mono">총 자산</p>
              <p className="text-2xl font-bold tracking-tighter">{formatCurrency(stats.totalAssets)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs opacity-70 uppercase font-mono">수익률 (ROI)</p>
              <p className={cn(
                "text-2xl font-bold tracking-tighter",
                stats.returnRate >= 0 ? "text-emerald-400" : "text-[#FF4D4D]"
              )}>
                {stats.returnRate >= 0 ? '+' : ''}{stats.returnRate.toFixed(2)}%
              </p>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 max-w-7xl mx-auto w-full">
          <CompactStatCard label="총 입금액" value={formatCurrency(stats.deposits)} />
          <CompactStatCard label="예수금 (Cash)" value={formatCurrency(stats.cash)} />
          <CompactStatCard label="평가금액" value={formatCurrency(stats.valuation)} highlight />
          <CompactStatCard label="보유 종목수" value={`${portfolio.length} 종목`} />
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl mx-auto w-full flex flex-col gap-6 p-6 overflow-auto min-h-0">
        {/* Top: Account Management Bar */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-3 border-b bg-[#758c64] text-white flex justify-between items-center px-6">
            <h3 className="font-bold text-xs uppercase tracking-wider">자산 및 예수금 관리</h3>
          </div>
          <div className="p-6">
            <BalanceForm 
              initialDeposits={profile?.totalDeposits || 0} 
              initialCash={profile?.cashBalance || 0} 
              onUpdate={handleUpdateBalances} 
            />
          </div>
        </section>

        {/* Middle: Portfolio Table (Wide) */}
        <section className="flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden shrink-0">
          <div className="p-4 border-b bg-slate-50 flex flex-wrap gap-4 justify-between items-center">
            <div className="flex items-center gap-4">
              <h3 className="font-bold text-sm text-slate-700 uppercase tracking-tight">보유 종목 현황</h3>
              <div className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200">
                <Clock size={14} className="text-slate-400 ml-2" />
                <input 
                  type="date" 
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-transparent border-none text-xs font-bold text-slate-600 focus:ring-0 px-2 cursor-pointer"
                />
                <button 
                  onClick={() => setSelectedDate(new Date().toISOString().split('T')[0])}
                  className={cn(
                    "text-[10px] px-2 py-1 rounded transition-all",
                    selectedDate === new Date().toISOString().split('T')[0] 
                      ? "bg-white text-[#004751] shadow-sm font-bold" 
                      : "text-slate-400 hover:text-slate-600"
                  )}
                >
                  오늘
                </button>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              {isPriceLoading && (
                <span className="text-[10px] text-slate-400 animate-pulse font-mono flex items-center gap-1">
                  <RefreshCcw size={10} className="animate-spin" /> 연동 중...
                </span>
              )}
              <button 
                onClick={() => syncAllPrices(true)}
                disabled={isPriceLoading}
                className="p-1.5 text-slate-400 hover:text-[#004751] hover:bg-slate-100 rounded-md transition-all flex items-center gap-1 text-[11px] font-bold"
                title="가격 새로고침"
              >
                <RefreshCcw size={14} className={cn(isPriceLoading && "animate-spin")} />
                시세 갱신
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead className="bg-slate-50 text-xs uppercase text-slate-400 font-bold border-b border-slate-100">
                <tr>
                  <th className="px-6 py-4 text-center">종목(코드)</th>
                  <th className="px-6 py-4 text-center">평균 단가</th>
                  <th className="px-6 py-4 text-center">현재가</th>
                  <th className="px-6 py-4 text-center">보유 수량</th>
                  <th className="px-6 py-4 text-center">총 금액</th>
                  <th className="px-6 py-4 text-center">평가손익</th>
                  <th className="px-6 py-4 text-center">수익률 %</th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-slate-100">
                {portfolio.length === 0 ? (
                  <tr><td colSpan={7} className="p-8 text-center text-slate-400 italic">보유 종목이 없습니다.</td></tr>
                ) : (
                  portfolio.map(p => (
                    <PortfolioRow key={p.ticker} item={p} currentPrice={currentPrices[p.ticker]} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Bottom: Trading Journal (Wide & Expanded) */}
        <section className="flex-1 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden min-h-[500px]">
          <div className="p-4 border-b bg-slate-50 flex justify-between items-center sticky top-0 z-10">
            <h3 className="font-bold text-sm text-slate-700 uppercase tracking-tight">매매 기록 일지</h3>
            <div className="flex gap-2">
              <button 
                onClick={() => setShowAddForm(true)} 
                className="bg-[#758c64] hover:bg-[#758c64]/90 text-white px-6 py-2 rounded-lg text-xs font-bold shadow-md hover:translate-y-[-1px] transition-all h-[42px]"
              >
                + 새로운 기록 추가
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse min-w-[1000px] table-fixed">
              <thead className="bg-slate-50 text-xs uppercase text-slate-400 font-bold border-b border-slate-100 sticky top-0 z-20">
                <tr>
                  <th className="px-6 py-4 text-center w-[12.5%]">일자</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">매수/매도</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">종목 코드</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">종목 이름</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">매매 수량</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">매매 단가</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">총 금액</th>
                  <th className="px-6 py-4 text-center w-[12.5%]">관리</th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-slate-100">
                {(() => {
                  const filtered = trades.filter(t => {
                    const tradeDate = t.date instanceof Timestamp ? t.date.toDate() : new Date(t.date);
                    const limitDate = new Date(selectedDate);
                    limitDate.setHours(23, 59, 59, 999);
                    return tradeDate <= limitDate;
                  });
                  
                  if (filtered.length === 0) {
                    return <tr><td colSpan={8} className="p-12 text-center text-slate-400 italic">선택된 날짜까지 기록된 매매 내역이 없습니다.</td></tr>;
                  }
                  
                  return filtered.map(t => (
                    <TradeRow 
                      key={t.id} 
                      trade={t} 
                      onDelete={() => t.id && handleDeleteTrade(t.id, t)} 
                      onEdit={() => setEditingTrade(t)}
                    />
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </section>

        {/* 매도 종목 현황 (Realized Sales Status) */}
        <section className="flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden shrink-0">
          <div className="p-4 border-b bg-slate-50 flex flex-wrap gap-4 justify-between items-center">
            <div className="flex items-center gap-4">
              <h3 className="font-bold text-sm text-slate-700 uppercase tracking-tight">매도 종목 현황</h3>
              <div className="flex flex-wrap items-center bg-slate-100 p-1.5 rounded-lg border border-slate-200 gap-2">
                <Clock size={14} className="text-slate-400 ml-1" />
                <div className="flex items-center gap-1">
                  <input 
                    type="date" 
                    value={salesStartDate}
                    onChange={(e) => setSalesStartDate(e.target.value)}
                    className="bg-transparent border-none text-xs font-bold text-slate-600 focus:ring-0 px-1 py-0 cursor-pointer w-[120px]"
                  />
                  <button 
                    onClick={() => setSalesStartDate(new Date().toISOString().split('T')[0])}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded transition-all font-semibold",
                      salesStartDate === new Date().toISOString().split('T')[0] 
                        ? "bg-white text-[#004751] shadow-sm font-bold" 
                        : "text-slate-400 hover:text-slate-600 bg-slate-200/50"
                    )}
                  >
                    오늘
                  </button>
                </div>
                <span className="text-xs text-slate-400 font-bold">~</span>
                <div className="flex items-center gap-1">
                  <input 
                    type="date" 
                    value={salesEndDate}
                    onChange={(e) => setSalesEndDate(e.target.value)}
                    className="bg-transparent border-none text-xs font-bold text-slate-600 focus:ring-0 px-1 py-0 cursor-pointer w-[120px]"
                  />
                  <button 
                    onClick={() => setSalesEndDate(new Date().toISOString().split('T')[0])}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded transition-all font-semibold",
                      salesEndDate === new Date().toISOString().split('T')[0] 
                        ? "bg-white text-[#004751] shadow-sm font-bold" 
                        : "text-slate-400 hover:text-slate-600 bg-slate-200/50"
                    )}
                  >
                    오늘
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead className="bg-slate-50 text-xs uppercase text-slate-400 font-bold border-b border-slate-100">
                <tr>
                  <th className="px-6 py-4 text-center">종목(코드)</th>
                  <th className="px-6 py-4 text-center">평균 단가</th>
                  <th className="px-6 py-4 text-center">매도가</th>
                  <th className="px-6 py-4 text-center">매도 수량</th>
                  <th className="px-6 py-4 text-center">총 금액</th>
                  <th className="px-6 py-4 text-center">평가손익</th>
                  <th className="px-6 py-4 text-center">수익률 %</th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-slate-100">
                {realizedSales.length === 0 ? (
                  <tr><td colSpan={7} className="p-8 text-center text-slate-400 italic">매도 종목 내역이 없습니다.</td></tr>
                ) : (
                  realizedSales.map(sale => (
                    <RealizedSaleRow key={sale.id} item={sale} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* 서버 데이터 저장 관리 (Admin 데이터 동기화) */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden shrink-0 p-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h3 className="font-bold text-sm text-slate-700 uppercase tracking-tight mb-1">데이터 영구 보관 (서버 백업)</h3>
            </div>
            <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
              <div className="relative flex-1 md:flex-initial">
                <input 
                  type="password" 
                  placeholder="비밀번호 입력" 
                  value={inputPassword}
                  onChange={(e) => setInputPassword(e.target.value)}
                  className="w-full md:w-[200px] border border-slate-200 rounded-lg text-xs p-3 bg-slate-50 focus:ring-1 focus:ring-[#758c64] outline-none font-mono"
                />
              </div>
              <button 
                onClick={handleSaveToServer}
                disabled={saveStatus.type === 'loading'}
                className="bg-[#758c64] hover:bg-[#758c64]/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg text-xs shadow-md hover:translate-y-[-1px] transition-all flex items-center justify-center gap-2 whitespace-nowrap"
              >
                {saveStatus.type === 'loading' && <Loader2 size={12} className="animate-spin" />}
                클라우드 서버 저장
              </button>
            </div>
          </div>
          
          {saveStatus.type !== 'idle' && (
            <div className={cn(
              "mt-4 p-3 rounded-lg text-xs font-semibold flex items-center gap-2 border",
              saveStatus.type === 'success' && "bg-emerald-50 border-emerald-200 text-emerald-800",
              saveStatus.type === 'error' && "bg-rose-50 border-rose-200 text-rose-800",
              saveStatus.type === 'loading' && "bg-slate-50 border-slate-200 text-slate-600 animate-pulse"
            )}>
              <AlertCircle size={14} className={cn(saveStatus.type === 'loading' && "animate-spin")} />
              <span>{saveStatus.message || (saveStatus.type === 'loading' && "서버에 세션 동기화 및 업로드 진행 중...")}</span>
            </div>
          )}
        </section>
      </main>

      <footer className="bg-white border-t border-slate-200 p-4 px-8 flex justify-between items-center text-[10px] text-slate-400 font-medium tracking-wide uppercase">
        <div>시스템 연결 상태: <span className="text-[#004751] font-bold">주식 매매 엔진 (매뉴얼)</span></div>
        <div className="flex space-x-6 items-center">
          <span className="flex items-center"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-2 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div> 시장 운영 중</span>
          <span>마지막 업데이트: {profile?.updatedAt instanceof Timestamp ? profile.updatedAt.toDate().toLocaleString('ko-KR') : '방금 전'}</span>
        </div>
      </footer>

      <AnimatePresence>
        {(showAddForm || editingTrade) && (
          <Modal 
            onClose={() => {
              setShowAddForm(false);
              setEditingTrade(null);
            }} 
            title={editingTrade ? "매매 기록 수정" : "새로운 매매 기록"}
          >
            <NewTradeForm 
              onAdd={handleAddTrade} 
              initialData={editingTrade || undefined}
            />
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

function RealizedSaleRow({ item }: { item: RealizedSaleItem; key?: string }) {
  return (
    <tr className="hover:bg-slate-50 transition-colors group">
      <td className="px-6 py-4 text-center">
        <div className="font-bold text-slate-700">{item.ticker}</div>
        <div className="text-[10px] text-slate-400 font-medium uppercase tracking-tighter">{item.companyName}</div>
        <div className="text-[9px] text-slate-400 font-mono mt-0.5">{item.date.toLocaleDateString('ko-KR')}</div>
      </td>
      <td className="px-6 py-4 text-center font-mono text-slate-500">{formatNumber(item.averagePrice)}</td>
      <td className="px-6 py-4 text-center font-mono font-medium text-slate-700">{formatNumber(item.sellPrice)}</td>
      <td className="px-6 py-4 text-center font-mono font-bold text-slate-600">{formatNumber(item.quantity)} 주</td>
      <td className="px-6 py-4 text-center font-mono font-bold text-slate-700">{formatCurrency(item.totalSellAmount)}</td>
      <td className="px-6 py-4 text-center font-mono font-bold text-xs text-[#000000]">
        {item.realizedProfitLoss > 0 ? '+' : ''}{formatCurrency(item.realizedProfitLoss)}
      </td>
      <td className="px-6 py-4 text-center">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-white text-[#000000]">
          {item.returnRate >= 0 ? '+' : ''}{item.returnRate.toFixed(2)}%
        </span>
      </td>
    </tr>
  );
}

function CompactStatCard({ label, value, highlight }: { label: string, value: string, highlight?: boolean }) {
  return (
    <div className="bg-white/10 p-4 rounded-xl backdrop-blur-md border border-white/10 shadow-sm transition-all hover:bg-white/15">
      <p className="text-xs opacity-60 uppercase font-bold tracking-widest mb-1">{label}</p>
      <p className={cn("text-lg font-bold tracking-tight", highlight ? "text-[#FFD700]" : "text-white")}>{value}</p>
    </div>
  );
}

function PortfolioRow({ item, currentPrice }: { item: PortfolioItem; currentPrice?: number; key?: string }) {
  const price = currentPrice || item.averagePrice;
  const gainLossRate = ((price - item.averagePrice) / item.averagePrice) * 100;
  const totalValuation = item.quantity * price;
  const totalProfitLoss = totalValuation - (item.averagePrice * item.quantity);

  return (
    <tr className="hover:bg-slate-50 transition-colors group">
      <td className="px-6 py-4 text-center">
        <div className="font-bold text-slate-700">{item.ticker}</div>
        <div className="text-[10px] text-slate-400 font-medium uppercase tracking-tighter">{item.companyName}</div>
      </td>
      <td className="px-6 py-4 text-center font-mono text-slate-500">{formatNumber(item.averagePrice)}</td>
      <td className="px-6 py-4 text-center font-mono font-medium text-slate-700">{formatNumber(price)}</td>
      <td className="px-6 py-4 text-center font-mono font-bold text-slate-600">{formatNumber(item.quantity)} 주</td>
      <td className="px-6 py-4 text-center font-mono font-bold text-slate-700">{formatCurrency(totalValuation)}</td>
      <td className="px-6 py-4 text-center font-mono font-bold text-xs text-[#000000]">
        {totalProfitLoss > 0 ? '+' : ''}{formatCurrency(totalProfitLoss)}
      </td>
      <td className="px-6 py-4 text-center">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-white text-[#000000]">
          {gainLossRate >= 0 ? '+' : ''}{gainLossRate.toFixed(2)}%
        </span>
      </td>
    </tr>
  );
}

function TradeRow({ trade, onDelete, onEdit }: { trade: Trade; onDelete: () => void; onEdit: () => void; key?: string }) {
  const date = trade.date instanceof Timestamp ? trade.date.toDate() : new Date(trade.date);
  const totalAmount = trade.price * trade.quantity;

  return (
    <>
      <tr className="hover:bg-slate-50/50 transition-colors group text-sm">
        <td className="px-6 py-4 text-center whitespace-nowrap text-slate-500 font-mono">
          {date.toLocaleDateString('ko-KR')}
        </td>
        <td className="px-6 py-4 text-center">
          <span className="px-2.5 py-1 rounded text-sm font-bold bg-white text-[#000000]">
            {trade.type === TradeType.BUY ? '매수' : '매도'}
          </span>
        </td>
        <td className="px-6 py-4 text-center font-bold text-slate-700">
          {trade.ticker}
        </td>
        <td className="px-6 py-4 text-center text-slate-600">
          {trade.companyName}
        </td>
        <td className="px-6 py-4 text-center font-mono text-slate-600">
          {formatNumber(trade.quantity)}
        </td>
        <td className="px-6 py-4 text-center font-mono text-slate-500">
          {formatNumber(trade.price)}
        </td>
        <td className="px-6 py-4 text-center font-mono font-bold text-slate-700">
          {formatCurrency(totalAmount)}
        </td>
        <td className="px-6 py-4 text-center">
          <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button 
              onClick={onEdit}
              className="p-1.5 text-slate-300 hover:text-[#758c64] transition-colors"
              title="수정"
            >
              <Edit2 size={14} />
            </button>
            <button 
              onClick={onDelete}
              className="p-1.5 text-slate-300 hover:text-rose-500 transition-colors"
              title="삭제"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </td>
      </tr>
      <tr className="bg-slate-50/40 border-b border-slate-100 text-xs">
        <td colSpan={8} className="px-8 py-3 text-left">
          <div className="flex items-start gap-2">
            <span className="text-[#071f0b] font-medium whitespace-pre-wrap">{trade.reason || "기록 없음"}</span>
          </div>
        </td>
      </tr>
    </>
  );
}

function BalanceForm({ initialDeposits, initialCash, onUpdate }: { initialDeposits: number, initialCash: number, onUpdate: (d: number, c: number) => void }) {
  const [d, setD] = useState(initialDeposits);
  const [c, setC] = useState(initialCash);
  const [addAmount, setAddAmount] = useState<number | ''>('');

  useEffect(() => {
    setD(initialDeposits);
    setC(initialCash);
  }, [initialDeposits, initialCash]);

  const handleApplyUpdate = () => {
    onUpdate(d, c);
  };

  const handleAdditionalDeposit = () => {
    if (!addAmount || addAmount <= 0) return;
    const newDeposits = d + Number(addAmount);
    const newCash = c + Number(addAmount);
    onUpdate(newDeposits, newCash);
    setAddAmount('');
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-6 items-end">
        <div className="flex gap-6 items-center flex-1 min-w-[300px]">
          <div className="space-y-1 flex-1">
            <label className="text-xs uppercase font-bold text-slate-400 block mb-[10px] pl-0">총 입금액 (초기설정)</label>
            <input 
              type="number" 
              value={d} 
              onChange={e => setD(Number(e.target.value))}
              className="w-full border border-slate-200 rounded-lg text-sm p-2.5 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none transition-all font-mono"
            />
          </div>
          <div className="space-y-1 flex-1">
            <label className="text-xs uppercase font-bold text-slate-400 block mb-[10px]">현재 예수금 (초기설정)</label>
            <input 
              type="number" 
              value={c} 
              onChange={e => setC(Number(e.target.value))}
              className="w-full border border-slate-200 rounded-lg text-sm p-2.5 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none transition-all font-mono"
            />
          </div>
        </div>
        <button 
          onClick={handleApplyUpdate}
          className="bg-[#758c64] text-white font-bold py-3 px-8 rounded-lg text-xs shadow-sm hover:bg-[#758c64]/90 transition-colors h-[42px]"
        >
          초기 자산 설정 저장
        </button>
      </div>

      <div className="border-t border-slate-100 pt-4 flex flex-wrap gap-4 items-end">
        <div className="space-y-1 max-w-[200px] flex-1">
          <label className="text-xs uppercase font-bold text-slate-400 block mb-1">추가 입금액</label>
          <input 
            type="number" 
            placeholder="예: 1000000"
            value={addAmount} 
            onChange={e => setAddAmount(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full border border-slate-200 rounded-lg text-sm p-2.5 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none transition-all font-mono"
          />
        </div>
        <button 
          onClick={handleAdditionalDeposit}
          disabled={!addAmount || addAmount <= 0}
          className="bg-[#758c64] hover:bg-[#758c64]/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-lg text-xs shadow-sm transition-colors h-[42px]"
        >
          + 추가 입금 반영
        </button>
        <p className="text-xs text-slate-400 self-center">
          * 추가 입금 시 총 입금액과 현재 예수금 둘 다에 동시에 누적 합산됩니다.
        </p>
      </div>
    </div>
  );
}

function NewTradeForm({ onAdd, initialData }: { onAdd: (t: Partial<Trade>) => void, initialData?: Trade }) {
  const [ticker, setTicker] = useState(initialData?.ticker || '');
  const [companyName, setCompanyName] = useState(initialData?.companyName || '');
  const [type, setType] = useState<TradeType>(initialData?.type || TradeType.BUY);
  const [quantity, setQuantity] = useState(initialData?.quantity || 0);
  const [price, setPrice] = useState(initialData?.price || 0);
  const [reason, setReason] = useState(initialData?.reason || '');
  
  const initialDateStr = initialData?.date 
    ? (initialData.date instanceof Timestamp ? initialData.date.toDate() : new Date(initialData.date)).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
    
  const [date, setDate] = useState(initialDateStr);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-1 space-y-1">
          <label className="text-[10px] uppercase font-bold text-slate-400">종목 코드</label>
          <input 
            placeholder="상징 코드 (예: 005930)"
            className="w-full border border-slate-200 rounded-lg text-sm p-3 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none"
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
          />
        </div>
        <div className="col-span-1 space-y-1">
          <label className="text-[10px] uppercase font-bold text-slate-400">종목명</label>
          <input 
            placeholder="삼성전자"
            className="w-full border border-slate-200 rounded-lg text-sm p-3 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none"
            value={companyName}
            onChange={e => setCompanyName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-slate-400">매매 타입</label>
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button 
              onClick={() => setType(TradeType.BUY)}
              className={cn("flex-1 py-1.5 text-xs font-bold rounded-md transition-all", type === TradeType.BUY ? "bg-white text-rose-500 shadow-sm" : "text-slate-400")}
            >매수</button>
            <button 
              onClick={() => setType(TradeType.SELL)}
              className={cn("flex-1 py-1.5 text-xs font-bold rounded-md transition-all", type === TradeType.SELL ? "bg-white text-blue-500 shadow-sm" : "text-slate-400")}
            >매도</button>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-slate-400">매매 일자</label>
          <input 
            type="date"
            className="w-full border border-slate-200 rounded-lg text-sm p-2 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-slate-400">수량</label>
          <input 
            type="number"
            className="w-full border border-slate-200 rounded-lg text-sm p-3 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none"
            value={quantity}
            onChange={e => setQuantity(Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-slate-400">체결 가격</label>
          <input 
            type="number"
            className="w-full border border-slate-200 rounded-lg text-sm p-3 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none"
            value={price}
            onChange={e => setPrice(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] uppercase font-bold text-slate-400">매매 사유</label>
          <span className="text-[10px] text-slate-400 font-mono">{reason.length}/500</span>
        </div>
        <textarea 
          maxLength={500}
          rows={5}
          placeholder="이 매매를 진행한 이유는 무엇인가요? 분석 내용을 입력하세요..."
          className="w-full border border-slate-200 rounded-lg text-sm p-3 bg-slate-50 focus:ring-1 focus:ring-[#004751] outline-none resize-none leading-relaxed"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
      </div>

      <button 
        onClick={() => onAdd({
          ticker,
          companyName,
          type,
          quantity,
          price,
          reason,
          date: Timestamp.fromDate(new Date(date))
        })}
        className="w-full bg-[#004751] text-white font-bold py-4 rounded-xl text-sm shadow-lg hover:bg-[#003840] transition-transform hover:translate-y-[-2px] active:scale-[0.98]"
      >
        {initialData ? '수정 내용 저장' : '일지 저장하기'}
      </button>
    </div>
  );
}

function Modal({ children, onClose, title }: { children: React.ReactNode, onClose: () => void, title: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
      />
      <motion.div 
        initial={{ y: 20, scale: 0.95, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 20, scale: 0.95, opacity: 0 }}
        className="relative bg-white rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl"
      >
        <div className="bg-[#004751] text-white p-5 flex justify-between items-center">
          <h3 className="font-bold text-sm tracking-wide uppercase">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-full transition-colors"><Plus className="rotate-45" size={20}/></button>
        </div>
        <div className="p-6">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function LoginView({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen bg-[#F1F5F9] flex flex-col items-center justify-center p-6 bg-[radial-gradient(circle_at_top_right,rgba(0,71,81,0.05),transparent_40%),radial-gradient(circle_at_bottom_left,rgba(0,71,81,0.05),transparent_40%)]">
      <div className="mb-12 text-center">
        <div className="inline-block p-4 bg-[#004751] rounded-2xl mb-6 shadow-xl">
          <BarChart3 className="text-[#FFD700]" size={48} />
        </div>
        <h1 className="text-5xl font-bold text-slate-800 tracking-tight mb-2">StockMaster</h1>
        <p className="text-slate-400 font-bold uppercase text-[10px] tracking-[0.4em]">Investment Analytics Engine</p>
      </div>
      
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl shadow-slate-200 border border-slate-100 p-10 text-center">
        <h2 className="text-xl font-bold text-slate-700 mb-4">Portfolio Journal</h2>
        <p className="text-sm text-slate-500 mb-8 leading-relaxed">
          관리하고 계신 나무증권 등의 실매매 내역을 직접 기록하고 분석하는 개인용 투자 일지입니다.
        </p>
        
        <button 
          onClick={onLogin}
          className="w-full bg-[#004751] text-white py-4 rounded-xl font-bold text-sm shadow-lg hover:bg-[#003840] transition-all flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-[0.98]"
        >
          <LogIn className="text-emerald-400" size={18} /> SIGN IN WITH GOOGLE
        </button>
        
        <p className="text-[10px] text-slate-400 mt-8 font-bold uppercase tracking-widest leading-loose">
          Secure Identity Verification • Cloud Storage
        </p>
      </div>
    </div>
  );
}
