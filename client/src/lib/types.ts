export type RoleCode = 'ADMIN' | 'WAITER' | 'KITCHEN' | 'BAR' | 'CASHIER';

export interface User {
  id: number;
  name: string;
  username: string;
  role: RoleCode;
  roleName: string;
  permissions: string[];
}

export type TableStatus = 'AVAILABLE' | 'OCCUPIED' | 'WAITING_ORDER' | 'IN_PREPARATION' | 'PARTIALLY_READY' | 'READY' | 'PENDING_PAYMENT';
export type ItemStatus = 'PENDING' | 'IN_PREPARATION' | 'READY' | 'DELIVERED' | 'CANCELLED';
export type OrderStatus = 'OPEN' | 'BILL_REQUESTED' | 'PAID' | 'CANCELLED';

export interface Area { id: number; code: 'KITCHEN' | 'BAR'; name: string }

export interface Product {
  id: number;
  name: string;
  description: string | null;
  price: string;
  imageUrl: string | null;
  categoryId: number;
  areaId: number;
  active: boolean;
  available: boolean;
  sortOrder: number;
  area: Area;
  category?: Category;
}

export interface Category {
  id: number;
  name: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
  defaultAreaId: number | null;
  products?: Product[];
  defaultArea?: Area | null;
  _count?: { products: number };
}

export interface TableInfo {
  id: number;
  number: number;
  name: string;
  zone: string | null;
  capacity: number;
  active: boolean;
  status: TableStatus;
  order: null | {
    id: number;
    number: number;
    status: OrderStatus;
    guests: number;
    openedAt: string;
    waiter: { id: number; name: string };
    itemCounts: Partial<Record<ItemStatus, number>>;
    total: number;
    paid: number;
    balance: number;
  };
}

export interface OrderItem {
  id: number;
  orderId: number;
  batchId: number;
  productId: number;
  productName: string;
  unitPrice: string;
  quantity: number;
  notes: string | null;
  status: ItemStatus;
  parentItemId: number | null;
  modifiedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  area: Area;
  createdBy: { id: number; name: string };
  cancelledBy: { id: number; name: string } | null;
  paidQuantity: number;
  lineTotal: number;
  unpaidQuantity?: number;
  unitShare?: number;
}

export interface PaymentMethod { id: number; code: string; name: string; kind: 'CASH' | 'CARD' | 'TRANSFER' | 'OTHER'; active: boolean; sortOrder: number }

export interface Payment {
  id: number;
  amount: string;
  receivedAmount: string | null;
  changeAmount: string;
  reference: string | null;
  payerLabel: string | null;
  splitMode: string;
  status: string;
  createdAt: string;
  paymentMethod: PaymentMethod;
  user: { id: number; name: string };
}

export interface Totals {
  subtotal: number;
  discount: number;
  service: number;
  tax: number;
  total: number;
  paid: number;
  balance: number;
  factor: number;
  taxRate: number;
  serviceRate: number;
  pricesIncludeTax: boolean;
}

export interface Order {
  id: number;
  number: number;
  status: OrderStatus;
  guests: number;
  notes: string | null;
  openedAt: string;
  closedAt: string | null;
  billRequestedAt: string | null;
  discountType: 'AMOUNT' | 'PERCENT' | null;
  discountValue: string;
  discountReason: string | null;
  table: { id: number; name: string; number: number };
  waiter: { id: number; name: string };
  closedBy: { id: number; name: string } | null;
  batches: { id: number; sequence: number; createdAt: string; createdBy: { id: number; name: string } }[];
  items: OrderItem[];
  payments: Payment[];
  totals: Totals;
  tableStatus: TableStatus | null;
  cancelReason: string | null;
}

export interface Account extends Order {
  cancelledItems: OrderItem[];
}

export interface KdsItem {
  id: number;
  productName: string;
  quantity: number;
  notes: string | null;
  status: ItemStatus;
  modifiedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledQuantity: number;
}

export interface KdsTicket {
  batchId: number;
  sequence: number;
  receivedAt: string;
  sentBy: { id: number; name: string };
  order: { id: number; number: number; status: OrderStatus; guests: number; table: { id: number; name: string; number: number }; waiter: { id: number; name: string } };
  items: KdsItem[];
  state: 'NEW' | 'IN_PROGRESS' | 'DONE';
  modified: boolean;
  progress: { ready: number; total: number };
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  data: { orderId?: number; tableId?: number; area?: string } | null;
  readAt: string | null;
  createdAt: string;
}

export interface Settings {
  id: number;
  name: string;
  legalName: string | null;
  legalId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxRate: string;
  serviceRate: string;
  pricesIncludeTax: boolean;
  timezone: string;
  receiptFooter: string | null;
  kdsWarningMinutes: number;
  kdsCriticalMinutes: number;
}

export interface CashSummary {
  openingAmount: number;
  totalSales: number;
  cashSales: number;
  cardSales: number;
  transferSales: number;
  otherSales: number;
  totalIncome: number;
  totalWithdrawals: number;
  totalExpenses: number;
  totalAdjustments: number;
  expectedCash: number;
  paymentsCount: number;
  byMethod: { code: string; name: string; kind: string; total: number; count: number }[];
}

export interface CashSession {
  id: number;
  registerId: number;
  openedAt: string;
  openingAmount: string;
  openingNotes: string | null;
  status: 'OPEN' | 'CLOSED';
  register: { id: number; name: string };
  openedBy: { id: number; name: string };
  closing?: CashClosing | null;
}

export interface CashClosing {
  id: number;
  closedAt: string;
  closedBy: { id: number; name: string };
  openingAmount: string;
  totalSales: string;
  cashSales: string;
  cardSales: string;
  transferSales: string;
  otherSales: string;
  totalIncome: string;
  totalWithdrawals: string;
  totalExpenses: string;
  totalAdjustments: string;
  expectedCash: string;
  countedCash: string;
  difference: string;
  notes: string | null;
}

export interface CashMovement {
  id: number;
  type: 'SALE' | 'INCOME' | 'WITHDRAWAL' | 'EXPENSE' | 'ADJUSTMENT';
  amount: string;
  description: string;
  createdAt: string;
  user: { id: number; name: string };
  paymentMethod: PaymentMethod | null;
  authorizedBy: { id: number; name: string } | null;
}
