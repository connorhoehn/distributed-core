import { randomBytes } from 'crypto';

/**
 * Generate a random ID using crypto random bytes
 */
export function createId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Delay utility for async operations
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref(); // Prevent Jest hanging
  });
}

/**
 * Validate if a string is a valid address (IP or hostname)
 */
export function isValidAddress(address: string): boolean {
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  // Basic hostname pattern
  const hostnamePattern = /^[a-zA-Z0-9.-]+$/;
  
  if (ipv4Pattern.test(address)) {
    // Validate IPv4 ranges
    const parts = address.split('.').map(Number);
    return parts.every(part => part >= 0 && part <= 255);
  }
  
  return hostnamePattern.test(address) && address.length > 0;
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
