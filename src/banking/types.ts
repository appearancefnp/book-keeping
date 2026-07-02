export interface BankTxn {
  bookingDate: string;
  amountCents: string;
  currency: string;
  side: 'credit' | 'debit';
  reference: string;
  counterparty: string;
  endToEndId: string;
}
