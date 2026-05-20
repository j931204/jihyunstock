import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR').format(Math.round(value));
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value);
}
