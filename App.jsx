import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';
// Làm tròn về số nguyên đồng để không hiện số lẻ kiểu 35.331.754,667 ₫
const vnd = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN') + ' ₫';
// Chuyển chuỗi số kiểu "1,500,000" / "1.500.000 ₫" thành số
const num = (s) => Number(String(s ?? '').replace(/[.,\s₫]/g, '')) || 0;
const splitRow = (l) => l.split(/\t|;/).map((x) => x.trim().replace(/^["']|["']$/g, ''));
// Ngày hôm nay theo GIỜ ĐỊA PHƯƠNG (toISOString dùng UTC nên 0h-7h sáng VN sẽ ra ngày hôm qua)
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Tách chuỗi "Số khung: A | Số sườn: B | Màu: C | Ghi chú: D" thành từng trường để nạp lại vào giỏ hàng khi sửa phiếu
const parseItemDetails = (str) => {
  const out = { chassis: '', frame: '', color: '', note: '' };
  String(str || '').split(' | ').forEach((part) => {
    const t = part.trim();
    if (!t) return;
    if (t.startsWith('Số khung:')) out.chassis = t.slice('Số khung:'.length).trim();
    else if (t.startsWith('Số sườn:')) out.frame = t.slice('Số sườn:'.length).trim();
    else if (t.startsWith('Màu:')) out.color = t.slice('Màu:'.length).trim();
    else if (t.startsWith('Ghi chú:')) out.note = t.slice('Ghi chú:'.length).trim();
    else out.note = out.note ? `${out.note} | ${t}` : t; // chuỗi cũ không theo định dạng -> đưa vào ghi chú
  });
  return out;
};

// Nạp 1 dòng hàng (từ API) vào giỏ, kèm số khung / số sườn / màu / ghi chú
const putItemIntoCart = (cartObj, item) => {
  const id = item.product_id;
  cartObj[id] = item.quantity;
  cartObj[id + '_price'] = item.price;
  cartObj[id + '_discount'] = item.discount || 0;
  const d = parseItemDetails(item.chassis_color);
  if (d.chassis) cartObj[id + '_chassis'] = d.chassis;
  if (d.frame) cartObj[id + '_frame'] = d.frame;
  if (d.color) cartObj[id + '_color'] = d.color;
  if (d.note) cartObj[id + '_note'] = d.note;
};

// Gộp số khung / số sườn / màu / ghi chú của 1 dòng hàng thành 1 chuỗi để lưu vào DB
const buildItemDetails = (cartObj, id) => [
  cartObj[id + '_chassis'] ? `Số khung: ${cartObj[id + '_chassis']}` : '',
  cartObj[id + '_frame'] ? `Số sườn: ${cartObj[id + '_frame']}` : '',
  cartObj[id + '_color'] ? `Màu: ${cartObj[id + '_color']}` : '',
  cartObj[id + '_note'] ? `Ghi chú: ${cartObj[id + '_note']}` : '',
].filter(Boolean).join(' | ');

// Bỏ dấu tiếng Việt để tìm kiếm không cần gõ dấu
const removeAccents = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

// Sắp xếp danh sách theo thời gian mới nhất lên đầu; cùng thời điểm thì phiếu tạo sau (id lớn hơn) đứng trước
const sortDesc = (list, key = 'created_at') => {
  const ts = (x) => {
    const t = new Date(x?.[key] || x?.created_at || 0).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  return [...(list || [])].sort((a, b) => {
    const d = ts(b) - ts(a);
    if (d !== 0) return d;
    const ia = Number(a?.id), ib = Number(b?.id);
    if (!Number.isNaN(ia) && !Number.isNaN(ib)) return ib - ia;
    return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
  });
};

// Khung bảng tự dài đến sát đáy màn hình; dữ liệu dài hơn thì có thanh trượt
function FillHeight({ children, bottom = 50, min = 220, className = '', style }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    el.style.maxHeight = Math.max(min, window.innerHeight - top - bottom) + 'px';
  };
  useLayoutEffect(fit); // đo lại mỗi lần giao diện vẽ lại
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div ref={ref} className={`scroll-table ${className}`} style={{ overflow: 'auto', ...style }}>
      {children}
    </div>
  );
}

// ===== Phiếu bảo hành =====
const addWarrantyDuration = (dateStr, amount, unit) => {
  const n = Number(amount) || 0;
  if (!dateStr || n <= 0) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  let dt;
  if (unit === 'day') {
    dt = new Date(y, m - 1, d + n);
  } else {
    const months = unit === 'year' ? n * 12 : n;
    const lastDay = new Date(y, m - 1 + months + 1, 0).getDate(); // tránh tràn ngày (31/1 + 1 tháng)
    dt = new Date(y, m - 1 + months, Math.min(d, lastDay));
  }
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};
const fmtDMY = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '---');
const warrantyStatus = (expiry) => {
  if (!expiry) return { key: 'none', text: '---', bg: '#f1f5f9', color: '#64748b', days: null };
  const days = Math.ceil((new Date(expiry + 'T23:59:59') - new Date()) / 86400000);
  if (days < 0) return { key: 'expired', text: 'Hết hạn', bg: '#fee2e2', color: '#dc2626', days };
  if (days <= 30) return { key: 'soon', text: `Sắp hết hạn (${days} ngày)`, bg: '#fef3c7', color: '#d97706', days };
  return { key: 'valid', text: 'Còn hạn', bg: '#dcfce7', color: '#16a34a', days };
};
const newWarrantyCode = (list) => {
  const max = (list || []).reduce((mx, w) => {
    const m = /^PBH(\d+)$/.exec(w.code || '');
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return 'PBH' + String(max + 1).padStart(5, '0');
};
const UNIT_LABEL = { month: 'tháng', year: 'năm', day: 'ngày' };
const nowLocalISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
async function api(path, options) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Có lỗi xảy ra (${res.status})`);
  return data;
}

const EMPTY_PRODUCT = { sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 };
const EMPTY_SUPPLIER = { code: '', name: '', phone: '', address: '', status: 'active' };
const EMPTY_CUSTOMER = { code: '', name: '', phone: '', address: '' };
// Dùng hàm để ngày luôn là ngày hiện tại tại thời điểm mở form
const newCashForm = () => ({
  type: 'OUT',
  amount: '',
  category: 'Mua hàng / Trả nợ NCC',
  payment_method: 'Chuyển khoản',
  reference_code: '',
  note: '',
  created_at: todayLocal(),
});

const EMPTY_PL_REPORT = {
  grossRevenue: 0,
  totalDiscount: 0,
  netRevenue: 0,
  cogs: 0,
  grossProfit: 0,
  expenses: { shipping: 0, tax: 0, salary: 0, other: 0, total: 0 },
  netProfit: 0,
};
const EMPTY_RETURN_DATA = { list: [], stats: { total: 0, pending: 0, completed: 0, totalRefund: 0 } };

// ===== Trả hàng nhập (trả lại NCC) =====
const isDoneReturn = (s) => /hoàn thành/i.test(String(s || ''));
const PR_DONE = 'Hoàn Thành (Trừ kho & giảm nợ NCC)';
const PR_REASONS = ['Hàng thừa / Trả lại', 'Hàng lỗi', 'Sai quy cách', 'Lý do khác'];
// ===== Trả hàng bán (khách trả lại) =====
const SR_DONE = 'Hoàn Thành (Cộng kho & trừ nợ)';
const newReturnForm = () => ({
  customer_name: '',
  invoice_code: '',
  return_date: todayLocal(),
  reason: 'Sản phẩm lỗi',
  refund_amount: 0,
  payment_method: 'Tiền mặt',
  status: SR_DONE,
  items: [],
});
// refund_received = số tiền thực tế đã thu lại từ NCC (sẽ tự sinh phiếu thu trong Sổ quỹ)
// refund_touched = người dùng đã tự sửa số tiền thu lại (nếu chưa thì tự = tổng giá trị hàng trả)
const newPrForm = () => ({ supplier_id: '', supplier_name: '', purchase_code: '', return_date: todayLocal(), reason: PR_REASONS[0], status: PR_DONE, items: [], refund_received: 0, refund_touched: false, payment_method: 'Tiền mặt' });

// Hiện lỗi ngay trên màn hình thay vì trắng trơn, để biết chính xác lỗi ở đâu
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Lỗi giao diện:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
          <h3 style={{ color: '#991b1b' }}>Có lỗi hiển thị giao diện</h3>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#fee2e2', padding: '12px', borderRadius: '6px', fontSize: '12px' }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button onClick={() => window.location.reload()} style={{ padding: '8px 16px', cursor: 'pointer' }}>Tải lại trang</button>
        </div>
      );
    }
    return this.props.children;
  }
}

  // 1. Đặt đoạn này ở đầu file App.jsx (ngoài cùng, trên function App)
const RESPONSIVE_CSS = `
.mobile-topbar, .sidebar-backdrop { display: none; }

/* ===== Đồng bộ font bảng + tiêu đề các màn hình (giống mục Nhà cung cấp) ===== */
.main-content > div:not([style*="position: fixed"]) table { font-size: 13px !important; }
.main-content > div:not([style*="position: fixed"]) table th,
.main-content > div:not([style*="position: fixed"]) table td { padding: 10px 12px !important; }
.main-content > div:not([style*="position: fixed"]) h2 { font-size: 1.35rem !important; }

/* Bảng có thanh trượt: dòng tiêu đề đứng yên khi kéo */
.scroll-table thead th { position: sticky; top: 0; z-index: 1; background: #f8fafc; }
.scroll-table td span { white-space: nowrap; }
.scroll-table tbody td:first-child { white-space: nowrap; }
.cash-table tbody td:nth-child(2) { white-space: nowrap; }

/* ===== Font + cỡ chữ đồng bộ toàn app ===== */
.layout { font-size: 14px; line-height: 1.45; -webkit-text-size-adjust: 100%; }
.layout button, .layout input, .layout select, .layout textarea { font-size: inherit; }
.layout h2 { font-size: 1.35rem; }
.layout h3 { font-size: 1.1rem; }
.layout h4 { font-size: 1rem; }

/* ===== Màn hình Phiếu bán hàng + Đơn đặt hàng: vừa khít chiều cao màn hình ===== */
.pos-page {
  display: flex; flex-direction: column; gap: 16px;
  height: calc(100vh - 48px);
}
.pos-page > div:first-child { flex-shrink: 0; margin-bottom: 0 !important; }
.pos-card {
  flex: 0 1 auto; min-height: 180px; overflow-y: auto;
  margin-bottom: 0 !important; box-sizing: border-box;
}
.pos-card thead th { position: sticky; top: 0; z-index: 1; background: #f8fafc; }

@media (max-width: 900px) {
  .mobile-topbar {
    display: flex; position: fixed; top: 0; left: 0; right: 0; height: 52px;
    background: #1e293b; color: #fff; align-items: center; gap: 12px;
    padding: 0 14px; z-index: 800; box-shadow: 0 2px 6px rgba(0,0,0,.2);
  }
  .mobile-topbar button {
    background: transparent; border: none; color: #fff; font-size: 26px;
    cursor: pointer; line-height: 1; padding: 4px 8px;
  }
  .mobile-topbar span { font-weight: bold; color: #38bdf8; font-size: 16px; }

  .sidebar {
    position: fixed !important; top: 0; left: 0; bottom: 0;
    width: 260px !important; max-width: 82vw; box-sizing: border-box;
    overflow-y: auto; transform: translateX(-100%);
    transition: transform .25s ease; z-index: 1100;
  }
  .sidebar.open { transform: translateX(0); }
  .sidebar-backdrop.show {
    display: block; position: fixed; inset: 0;
    background: rgba(0,0,0,.45); z-index: 1050;
  }

  .main-content {
    padding: 64px 10px 16px !important; width: 100%;
    box-sizing: border-box; min-width: 0;
  }
  /* Điện thoại: trang cuộn bình thường, mỗi bảng tối đa 60% chiều cao màn hình */
  .pos-page { height: auto; }
  .pos-card { flex: none; max-height: 60vh; }
  .pos-card thead th { position: static; }
  
  .main-content table { display: block; overflow-x: auto; white-space: nowrap; max-width: 100%; }
  .main-content div[style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
  .main-content div[style*="repeat("] { grid-template-columns: repeat(2, 1fr) !important; }
  .main-content div[style*="grid-column"] { grid-column: auto !important; }
  .main-content div[style*="justify-content: space-between"] { flex-wrap: wrap !important; gap: 8px; }
  .main-content div[style*="position: fixed"] { padding: 8px; box-sizing: border-box; }
  .main-content div[style*="position: fixed"] > div {
    width: 100% !important; max-width: 100% !important;
    max-height: 94vh !important; box-sizing: border-box;
  }
  .main-content input, .main-content select, .main-content textarea { font-size: 16px; }
  /* Danh sách sản phẩm trong popup chỉ cao ~2-3 dòng, kéo để xem thêm */
  .main-content .pos-product-list { max-height: 180px !important; overflow-y: auto !important; }
  .main-content .pos-product-list > div { word-break: break-word; }

  /* Cột lưới không bị nội dung dài kéo tràn màn hình */
  .main-content div[style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
  .main-content div[style*="grid-template-columns"] > * { min-width: 0; }
  .main-content input, .main-content select, .main-content textarea { max-width: 100%; }

    /* ===== Báo cáo X-N-T trên điện thoại ===== */
  /* 4 ô KPI: 2 ô mỗi dòng, gọn hơn */
  .main-content div.report-kpis[style] { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; }
  .report-kpis > div { padding: 12px !important; }
  .report-kpis > div > span { font-size: 10px !important; line-height: 1.3; display: block; }
  .report-kpis > div > div { font-size: 15px !important; margin-top: 6px !important; word-break: break-word; }

  /* Thanh lọc: ô tìm kiếm + bộ chọn thời gian vừa khít màn hình */
  .report-filter { padding: 10px !important; gap: 8px !important; }
  .report-filter > input { flex: 1 1 100% !important; min-width: 0 !important; width: 100% !important; padding: 7px 10px !important; font-size: 14px !important; }
  .report-filter-range { flex: 1 1 100% !important; flex-wrap: nowrap !important; gap: 6px !important; }
  .report-filter-range > span:first-child { font-size: 12px !important; white-space: nowrap; }
  .report-filter-range select,
  .report-filter-range input { flex: 1 1 0 !important; min-width: 0 !important; width: auto !important; padding: 6px 8px !important; font-size: 13px !important; }
  /* Nút Lọc dữ liệu nhỏ lại */
  .report-filter > button { padding: 7px 18px !important; font-size: 13px !important; }
}
  /* Đồng nhất font (áp dụng cả máy tính và điện thoại) */
.layout, .layout button, .layout input, .layout select, .layout textarea {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
`;
export default function App() {
  return (
    <ErrorBoundary>
      <style>{RESPONSIVE_CSS}</style>
      <AppMain />
    </ErrorBoundary>
  );
}

function AppMain() {
  const [currentView, setCurrentView] = useState('pos'); // 'pos' | 'return-orders' | 'purchase-returns' | 'products' | 'suppliers' | 'purchases' | 'customers' | 'settings' | 'inventory-report' | 'cash-book' | 'profit-loss-report'
  const [sidebarOpen, setSidebarOpen] = useState(false); // menu trái trên điện thoại
  // ===== States cho Đơn hàng / Phiếu bán hàng (popup tạo đơn) =====
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [invoicesList, setInvoicesList] = useState([]);
  const [ordersList, setOrdersList] = useState([]);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [modalOrderType, setModalOrderType] = useState('invoices'); // 'invoices' | 'orders'
  const [orderDate, setOrderDate] = useState(todayLocal());
  const [paymentMethod, setPaymentMethod] = useState('Tiền mặt');
  const [paidAmount, setPaidAmount] = useState(0);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [posCustomer, setPosCustomer] = useState({ name: '', phone: '', address: '' });
  const [posProductKeyword, setPosProductKeyword] = useState('');
  const [showPosSuggest, setShowPosSuggest] = useState(false);
  const [depositFromOrder, setDepositFromOrder] = useState(0); // tạm ứng lấy từ đơn đặt hàng khi xuất phiếu bán
  const [productSearchKeyword, setProductSearchKeyword] = useState(''); // dùng cho phiếu nhập
  const [editingOrderId, setEditingOrderId] = useState(null); // Lưu ID đơn đang sửa
  const [editingInvoiceId, setEditingInvoiceId] = useState(null); // Lưu ID phiếu đang sửa (nếu có)
  const [invoiceForm, setInvoiceForm] = useState({ customer_name: '', items: [] });
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [editingInvoiceOriginalQty, setEditingInvoiceOriginalQty] = useState({}); // SL cũ của phiếu đang sửa (để kiểm tra tồn kho)
  const [activeChassisProduct, setActiveChassisProduct] = useState(null);
  // Tìm kiếm + lọc thời gian cho màn hình Tạo đơn hàng
  const [posSearch, setPosSearch] = useState('');
  const [posPeriod, setPosPeriod] = useState('all'); // 'all' | 'month' | 'quarter' | 'year' | 'custom'
  const [posMonth, setPosMonth] = useState(() => todayLocal().slice(0, 7));
  const [posYear, setPosYear] = useState(() => todayLocal().slice(0, 4));
  const [posQuarter, setPosQuarter] = useState(() => String(Math.ceil((new Date().getMonth() + 1) / 3)));
  const [posFrom, setPosFrom] = useState('');
  const [posTo, setPosTo] = useState('');

  const [returnOrdersData, setReturnOrdersData] = useState(EMPTY_RETURN_DATA);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnForm, setReturnForm] = useState(newReturnForm);
  const [editingReturnId, setEditingReturnId] = useState(null); // ID phiếu trả hàng bán đang sửa (null = tạo mới)
  const [returnDetail, setReturnDetail] = useState(null); // Dữ liệu popup xem chi tiết phiếu trả hàng bán

  const loadReturnOrders = async () => {
    try {
      const res = await api('/api/return-orders');
      if (res && res.success) {
        const d = res.data || {};
        setReturnOrdersData({
          list: sortDesc(Array.isArray(d.list) ? d.list : [], 'return_date'),
          stats: { ...EMPTY_RETURN_DATA.stats, ...(d.stats || {}) },
        });
      }
    } catch (err) {
      console.error('Lỗi tải danh sách trả hàng:', err);
    }
  };

  // ----- Popup tạo phiếu trả: tìm khách, chọn phiếu gốc, thêm sản phẩm -----
  const [returnCustomerSearch, setReturnCustomerSearch] = useState('');
  const [showReturnCustomerDropdown, setShowReturnCustomerDropdown] = useState(false);
  const [returnProductKeyword, setReturnProductKeyword] = useState('');
  const [returnLoading, setReturnLoading] = useState(false);

  const calcReturnTotal = (items) =>
    (items || []).reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0);

  // Cập nhật danh sách hàng trả và tự tính lại số tiền hoàn
  const setReturnItems = (items) =>
    setReturnForm((f) => ({ ...f, items, refund_amount: calcReturnTotal(items) }));

  const updateReturnItem = (index, patch) =>
    setReturnItems((returnForm.items || []).map((it, i) => (i === index ? { ...it, ...patch } : it)));

  const removeReturnItem = (index) =>
    setReturnItems((returnForm.items || []).filter((_, i) => i !== index));

  const addReturnProduct = (p) => {
    const items = returnForm.items || [];
    const exist = items.find((it) => it.product_id === p.id);
    const next = exist
      ? items.map((it) => {
          if (it.product_id !== p.id) return it;
          const q = it.quantity + 1;
          return { ...it, quantity: it.max_qty ? Math.min(q, it.max_qty) : q };
        })
      : [...items, { product_id: p.id, sku: p.sku || '', name: p.name, quantity: 1, max_qty: null, price: Number(p.price) || 0 }];
    setReturnItems(next);
    setReturnProductKeyword('');
  };

  // Mở popup tạo phiếu trả hàng bán mới
  const openCreateReturn = () => {
    setEditingReturnId(null);
    setReturnForm(newReturnForm());
    setReturnCustomerSearch('');
    setReturnProductKeyword('');
    setShowReturnCustomerDropdown(false);
    setShowReturnModal(true);
  };

  const closeReturnModal = () => {
    setShowReturnModal(false);
    setEditingReturnId(null);
  };

  // Chọn phiếu bán gốc -> tự nạp các sản phẩm của phiếu đó vào danh sách trả
  const handleSelectReturnInvoice = async (invCode) => {
    if (!invCode) {
      setReturnForm((f) => ({ ...f, invoice_code: '' }));
      return;
    }
    const inv = (invoicesList || []).find((i) => String(i.code || i.id) === String(invCode));
    setReturnForm((f) => ({ ...f, invoice_code: invCode, customer_name: inv?.customer_name || f.customer_name }));
    if (inv?.customer_name) setReturnCustomerSearch(inv.customer_name);
    if (!inv) return;

    setReturnLoading(true);
    try {
      const details = await api(`/api/invoices/${inv.id}`);
      const items = (details.items || []).map((it) => {
        const qty = Number(it.quantity) || 0;
        const net = (Number(it.price) || 0) * qty - (Number(it.discount) || 0); // đã trừ giảm giá dòng
        const prod = (products || []).find((p) => p.id === it.product_id);
        return {
          product_id: it.product_id,
          sku: it.sku || prod?.sku || '',
          name: it.product_name || it.name || prod?.name || '',
          quantity: qty,
          max_qty: qty,
          price: qty > 0 ? Math.round(net / qty) : (Number(it.price) || 0),
        };
      });
      setReturnItems(items);
    } catch (e) {
      alert('Lỗi tải chi tiết phiếu bán: ' + e.message);
    } finally {
      setReturnLoading(false);
    }
  };

  // Tạo mới HOẶC cập nhật phiếu trả hàng bán (tùy editingReturnId)
  const handleCreateReturnOrder = async () => {
    const items = (returnForm.items || [])
      .filter((it) => Number(it.quantity) > 0)
      .map((it) => ({ product_id: it.product_id, sku: it.sku, name: it.name, quantity: Number(it.quantity), price: Number(it.price) || 0 }));

    if (!returnForm.customer_name) { alert('Vui lòng chọn khách hàng!'); return; }
    if (items.length === 0) { alert('Vui lòng chọn ít nhất 1 sản phẩm trả lại!'); return; }

    const isEdit = !!editingReturnId;
    try {
      const res = await api(isEdit ? `/api/return-orders/${editingReturnId}` : '/api/return-orders', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...returnForm, refund_amount: Number(returnForm.refund_amount) || 0, items })
      });
      if (res && res.success) {
        alert(isEdit ? 'Cập nhật phiếu trả hàng thành công!' : 'Tạo phiếu trả hàng thành công!');
        closeReturnModal();
        loadReturnOrders();
        loadData(); // cập nhật lại tồn kho / công nợ
      } else {
        alert((res && res.error) || (isEdit ? 'Có lỗi xảy ra khi cập nhật phiếu trả.' : 'Có lỗi xảy ra khi tạo phiếu trả.'));
      }
    } catch (err) {
      console.error('Lỗi lưu phiếu trả:', err);
      alert('Lỗi: ' + err.message);
    }
  };

  // Xem chi tiết phiếu trả hàng bán
  const handleViewReturn = async (item) => {
    try { setReturnDetail(await api(`/api/return-orders/${item.id}`)); }
    catch (e) { alert('Lỗi tải chi tiết: ' + e.message); }
  };

  // Sửa phiếu trả hàng bán: nạp dữ liệu cũ vào popup, khi lưu sẽ gọi PUT (cập nhật đúng phiếu này)
  const handleEditReturn = async (item) => {
    try {
      const d = await api(`/api/return-orders/${item.id}`);
      setEditingReturnId(item.id);
      setReturnForm({
        customer_name: d.customer_name || '',
        invoice_code: d.invoice_code || '',
        return_date: d.return_date ? String(d.return_date).slice(0, 10) : todayLocal(),
        reason: d.reason || 'Sản phẩm lỗi',
        refund_amount: Number(d.refund_amount) || 0,
        payment_method: d.payment_method || 'Tiền mặt',
        status: isDoneReturn(d.status) ? SR_DONE : 'Đang xử lý',
        items: (d.items || []).map((it) => ({
          product_id: it.product_id,
          sku: it.sku || '',
          name: it.product_name || '',
          quantity: Number(it.quantity) || 0,
          max_qty: null,
          price: Number(it.price) || 0,
        })),
      });
      setReturnCustomerSearch(d.customer_name || '');
      setReturnProductKeyword('');
      setShowReturnCustomerDropdown(false);
      setShowReturnModal(true);
    } catch (e) {
      alert('Lỗi tải phiếu để sửa: ' + e.message);
    }
  };

  // Xóa phiếu trả hàng bán
  const handleDeleteReturn = async (item) => {
    if (!confirm(`Xóa phiếu trả hàng ${item.code}? Hàng đã cộng lại kho sẽ được trừ ra và phiếu chi hoàn tiền trong Thu chi (nếu có) cũng bị xóa.`)) return;
    try {
      await api(`/api/return-orders/${item.id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `Đã xóa phiếu trả hàng ${item.code}` });
      loadReturnOrders();
      loadData();
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  };

  // ===== Trả hàng nhập (trả lại NCC) =====
  const [prData, setPrData] = useState({ list: [], stats: { total: 0, totalAmount: 0, completed: 0 } });
  const [prSearch, setPrSearch] = useState('');
  const [prStatus, setPrStatus] = useState('');
  const [prReason, setPrReason] = useState('');
  const [prDate, setPrDate] = useState('');
  const [showPrModal, setShowPrModal] = useState(false);
  const [prForm, setPrForm] = useState(newPrForm);
  const [editingPrId, setEditingPrId] = useState(null); // ID phiếu trả hàng nhập đang sửa (null = tạo mới)
  const [prSupplierSearch, setPrSupplierSearch] = useState('');
  const [showPrSupplierDropdown, setShowPrSupplierDropdown] = useState(false);
  const [prProductKeyword, setPrProductKeyword] = useState('');
  const [prLoading, setPrLoading] = useState(false);
  const [prDetail, setPrDetail] = useState(null);

  const loadPurchaseReturns = async () => {
    try {
      const res = await api('/api/purchase-returns');
      if (res && res.success) {
        const d = res.data || {};
        setPrData({
          list: sortDesc(Array.isArray(d.list) ? d.list : [], 'return_date'),
          stats: { total: 0, totalAmount: 0, completed: 0, ...(d.stats || {}) },
        });
      }
    } catch (e) {
      setMsg({ type: 'err', text: 'Không tải được trả hàng nhập: ' + e.message });
    }
  };

  const calcPrTotal = (items) => (items || []).reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0);
  // Đổi danh sách hàng trả -> nếu người dùng chưa tự sửa thì "đã thu lại" tự = tổng giá trị hàng trả
  const setPrItems = (items) => setPrForm((f) => ({ ...f, items, refund_received: f.refund_touched ? f.refund_received : calcPrTotal(items) }));
  const updatePrItem = (index, patch) => setPrItems((prForm.items || []).map((it, i) => (i === index ? { ...it, ...patch } : it)));
  const removePrItem = (index) => setPrItems((prForm.items || []).filter((_, i) => i !== index));

  const addPrProduct = (p) => {
    const items = prForm.items || [];
    const exist = items.find((it) => it.product_id === p.id);
    const next = exist
      ? items.map((it) => {
          if (it.product_id !== p.id) return it;
          const q = it.quantity + 1;
          return { ...it, quantity: it.max_qty ? Math.min(q, it.max_qty) : q };
        })
      : [...items, { product_id: p.id, sku: p.sku || '', name: p.name, quantity: 1, max_qty: null, price: Number(p.import_price) || Number(p.price) || 0 }];
    setPrItems(next);
    setPrProductKeyword('');
  };

  // Mở popup tạo phiếu trả hàng nhập mới
  const openCreatePr = () => {
    setEditingPrId(null);
    setPrForm(newPrForm());
    setPrSupplierSearch('');
    setPrProductKeyword('');
    setShowPrSupplierDropdown(false);
    setShowPrModal(true);
  };

  const closePrModal = () => {
    setShowPrModal(false);
    setEditingPrId(null);
  };

  // Chọn phiếu nhập gốc -> tự nạp NCC và các sản phẩm của phiếu đó
  const handleSelectPrPurchase = async (poId) => {
    if (!poId) { setPrForm((f) => ({ ...f, purchase_code: '' })); return; }
    const po = (purchaseOrders || []).find((x) => String(x.id) === String(poId));
    if (!po) return;
    setPrForm((f) => ({ ...f, purchase_code: po.code, supplier_id: po.supplier_id, supplier_name: po.supplier_name || f.supplier_name }));
    if (po.supplier_name) setPrSupplierSearch(po.supplier_name);
    setPrLoading(true);
    try {
      const details = await api(`/api/purchase_orders/${po.id}`);
      const items = (details.items || []).map((it) => {
        const qty = Number(it.quantity) || 0;
        const net = Number(it.total) || ((Number(it.price) || 0) * qty - (Number(it.discount) || 0));
        return {
          product_id: it.product_id,
          sku: it.sku || '',
          name: it.product_name || '',
          quantity: qty,
          max_qty: qty,
          price: qty > 0 ? Math.round(net / qty) : (Number(it.price) || 0),
        };
      });
      setPrItems(items);
    } catch (e) {
      alert('Lỗi tải chi tiết phiếu nhập: ' + e.message);
    } finally {
      setPrLoading(false);
    }
  };

  // Tạo mới HOẶC cập nhật phiếu trả hàng nhập (tùy editingPrId)
  const handleCreatePurchaseReturn = async () => {
    const items = (prForm.items || [])
      .filter((it) => Number(it.quantity) > 0)
      .map((it) => ({ product_id: it.product_id, quantity: Number(it.quantity), price: Number(it.price) || 0 }));
    if (!prForm.supplier_id) { alert('Vui lòng chọn nhà cung cấp!'); return; }
    if (items.length === 0) { alert('Vui lòng chọn ít nhất 1 sản phẩm trả lại!'); return; }

    const totalReturn = items.reduce((s, it) => s + it.quantity * it.price, 0);
    const refundReceived = Math.max(0, Number(prForm.refund_received) || 0);
    if (refundReceived > totalReturn) {
      alert('Số tiền đã thu lại từ nhà cung cấp không được lớn hơn tổng giá trị hàng trả!');
      return;
    }

    const isEdit = !!editingPrId;
    try {
      const res = await api(isEdit ? `/api/purchase-returns/${editingPrId}` : '/api/purchase-returns', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify({
          supplier_id: prForm.supplier_id,
          purchase_code: prForm.purchase_code,
          return_date: prForm.return_date,
          reason: prForm.reason,
          status: prForm.status,
          refund_received: refundReceived,
          payment_method: prForm.payment_method,
          items,
        }),
      });
      if (res && res.success) {
        setMsg({ type: 'ok', text: isEdit ? `Cập nhật phiếu trả hàng nhập ${res.code} thành công!` : `Tạo phiếu trả hàng nhập ${res.code} thành công!` });
        closePrModal();
        loadPurchaseReturns();
        loadData(); // cập nhật tồn kho / công nợ NCC
      }
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  };

  const handleViewPr = async (item) => {
    try { setPrDetail(await api(`/api/purchase-returns/${item.id}`)); }
    catch (e) { alert('Lỗi tải chi tiết: ' + e.message); }
  };

  // Sửa phiếu trả hàng nhập: nạp dữ liệu cũ vào popup, khi lưu sẽ gọi PUT (cập nhật đúng phiếu này)
  const handleEditPr = async (item) => {
    try {
      const d = await api(`/api/purchase-returns/${item.id}`);
      setEditingPrId(item.id);
      setPrForm({
        supplier_id: d.supplier_id,
        supplier_name: d.supplier_name || '',
        purchase_code: d.purchase_code || '',
        return_date: d.return_date ? String(d.return_date).slice(0, 10) : todayLocal(),
        reason: d.reason || PR_REASONS[0],
        status: isDoneReturn(d.status) ? PR_DONE : 'Đang xử lý',
        items: (d.items || []).map((it) => ({
          product_id: it.product_id,
          sku: it.sku || '',
          name: it.product_name || '',
          quantity: Number(it.quantity) || 0,
          max_qty: null,
          price: Number(it.price) || 0,
        })),
        refund_received: Number(d.refund_received ?? d.received_amount) || 0,
        refund_touched: true, // giữ nguyên số đã thu lại của phiếu, không tự đổi theo tổng tiền
        payment_method: d.payment_method || 'Tiền mặt',
      });
      setPrSupplierSearch(d.supplier_name || '');
      setPrProductKeyword('');
      setShowPrSupplierDropdown(false);
      setShowPrModal(true);
    } catch (e) {
      alert('Lỗi tải phiếu để sửa: ' + e.message);
    }
  };

  const handleDeletePr = async (item) => {
    if (!confirm(`Xóa phiếu trả hàng nhập ${item.code}? Hàng đã trả sẽ được cộng lại vào kho.`)) return;
    try {
      await api(`/api/purchase-returns/${item.id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `Đã xóa phiếu ${item.code}` });
      loadPurchaseReturns();
      loadData();
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  };

  // ===== States cho Quản lý Sản phẩm =====
  const [showProductModal, setShowProductModal] = useState(false);
  const [showProductImportModal, setShowProductImportModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT);
  const [productImportText, setProductImportText] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [activeProductTab, setActiveProductTab] = useState('info'); // 'info' hoặc 'card'
  const [stockCardList, setStockCardList] = useState([]);
  const [productListSearch, setProductListSearch] = useState('');
  const [showProductSuggest, setShowProductSuggest] = useState(false);

  // ===== States cho Nhà cung cấp & Nhập hàng =====
  const [suppliers, setSuppliers] = useState([]);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');

  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [showCreatePurchaseModal, setShowCreatePurchaseModal] = useState(false);
  const [selectedPurchaseOrder, setSelectedPurchaseOrder] = useState(null);
  const [showViewPurchaseModal, setShowViewPurchaseModal] = useState(false);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [importDate, setImportDate] = useState(() => nowLocalISO().slice(0, 16));

  const [purchaseForm, setPurchaseForm] = useState({
    supplier_id: '',
    payment_method: 'cash',
    paid_amount: '',
    created_at: nowLocalISO().slice(0, 16), // Khởi tạo sẵn thời gian hiện tại
  });
  const [purchaseItems, setPurchaseItems] = useState([]);
  const [supplierSearchKeyword, setSupplierSearchKeyword] = useState('');
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);
  const [supplierListSearch, setSupplierListSearch] = useState('');
  const [supPeriod, setSupPeriod] = useState('all'); // 'all' | 'month' | 'quarter' | 'year' | 'custom'
  const [supMonth, setSupMonth] = useState(() => todayLocal().slice(0, 7));
  const [supYear, setSupYear] = useState(() => todayLocal().slice(0, 4));
  const [supQuarter, setSupQuarter] = useState(() => String(Math.ceil((new Date().getMonth() + 1) / 3)));
  const [supFrom, setSupFrom] = useState('');
  const [supTo, setSupTo] = useState('');
  const [purSearch, setPurSearch] = useState('');
  const [purPeriod, setPurPeriod] = useState('all'); // 'all' | 'month' | 'quarter' | 'year' | 'custom'
  const [purMonth, setPurMonth] = useState(() => todayLocal().slice(0, 7));
  const [purYear, setPurYear] = useState(() => todayLocal().slice(0, 4));
  const [purQuarter, setPurQuarter] = useState(() => String(Math.ceil((new Date().getMonth() + 1) / 3)));
  const [purFrom, setPurFrom] = useState('');
  const [purTo, setPurTo] = useState('');

  const [supplierForm, setSupplierForm] = useState(EMPTY_SUPPLIER);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [supplierTab, setSupplierTab] = useState('info');
  const [supplierHistory, setSupplierHistory] = useState({ purchases: [], payments: [], returns: [] });
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [supplierCashItems, setSupplierCashItems] = useState([]); // sổ thu chi, dùng để dựng lịch sử thanh toán
  const [supplierPrList, setSupplierPrList] = useState([]); // phiếu trả hàng nhập của NCC đang xem

  // ===== States cho Báo cáo Xuất - Nhập - Tồn =====
  const [reportItems, setReportItems] = useState([]);
  const [reportSummary, setReportSummary] = useState({ totalOpeningVal: 0, totalImportVal: 0, totalExportVal: 0, totalClosingVal: 0 });
  const [reportSearch, setReportSearch] = useState('');
  const reportReqRef = useRef(0); // đánh số mỗi lần gọi để bỏ qua kết quả cũ trả về chậm

  const [reportType, setReportType] = useState('month'); // 'day', 'month', 'quarter', 'year', 'custom'
  const [reportValue, setReportValue] = useState(nowLocalISO().slice(0, 7)); // ví dụ: '2026-10'
  const [reportStartDate, setReportStartDate] = useState('');
  const [reportEndDate, setReportEndDate] = useState('');

  // ===== States cho Khách hàng =====
  const [customers, setCustomers] = useState([]);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showCustomerImportModal, setShowCustomerImportModal] = useState(false);
  const [customerForm, setCustomerForm] = useState(EMPTY_CUSTOMER);
  const [customerImportText, setCustomerImportText] = useState('');
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [selectedCustomerDetail, setSelectedCustomerDetail] = useState(null);
  const [customerDetailData, setCustomerDetailData] = useState({ invoices: [], payments: [] });
  const [customerDetailTab, setCustomerDetailTab] = useState('orders'); // 'orders' | 'payments'
  const [customerListSearch, setCustomerListSearch] = useState('');
  const [cusPeriod, setCusPeriod] = useState('all'); // 'all' | 'month' | 'quarter' | 'year' | 'custom'
  const [cusMonth, setCusMonth] = useState(() => todayLocal().slice(0, 7));
  const [cusYear, setCusYear] = useState(() => todayLocal().slice(0, 4));
  const [cusQuarter, setCusQuarter] = useState(() => String(Math.ceil((new Date().getMonth() + 1) / 3)));
  const [cusFrom, setCusFrom] = useState('');
  const [cusTo, setCusTo] = useState('');
  const [customerCashItems, setCustomerCashItems] = useState([]); // sổ thu chi, để dựng lịch sử thanh toán
  const [customerReturnList, setCustomerReturnList] = useState([]); // phiếu trả hàng bán của khách đang xem
  const [showCustomerDetailModal, setShowCustomerDetailModal] = useState(false);

  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [warranties, setWarranties] = useState(() => {
  try { const v = JSON.parse(localStorage.getItem('warranties') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
});
  const [showWarrantyModal, setShowWarrantyModal] = useState(false);
  const [warrantyForm, setWarrantyForm] = useState(null);
  const [editingWarrantyId, setEditingWarrantyId] = useState(null);
  const [warrantyDetail, setWarrantyDetail] = useState(null);
  const [warrantySearch, setWarrantySearch] = useState('');
  const [warrantyFilter, setWarrantyFilter] = useState('all'); // all | valid | soon | expired

  // ===== States cho Thu chi (Sổ quỹ) =====
  const [showCashModal, setShowCashModal] = useState(false);
  const [cashItems, setCashItems] = useState([]);
  const [cashSummary, setCashSummary] = useState({ totalIn: 0, totalOut: 0, netProfit: 0, balance: 0 });
  const [cashForm, setCashForm] = useState(newCashForm);
  const [editingCashId, setEditingCashId] = useState(null);
  const [selectedCashItem, setSelectedCashItem] = useState(null);
  const [cashSearch, setCashSearch] = useState('');
  const [cashPeriod, setCashPeriod] = useState('all'); // 'all' | 'month' | 'quarter' | 'year' | 'custom'
  const [cashMonth, setCashMonth] = useState(() => todayLocal().slice(0, 7));
  const [cashYear, setCashYear] = useState(() => todayLocal().slice(0, 4));
  const [cashQuarter, setCashQuarter] = useState(() => String(Math.ceil((new Date().getMonth() + 1) / 3)));
  const [cashFrom, setCashFrom] = useState('');
  const [cashTo, setCashTo] = useState('');

  const loadCashBook = async () => {
    try {
      const res = await api('/api/cash-book');
      if (res && res.success) {
        setCashItems(sortDesc(res.items || []));
        setCashSummary(res.summary || { totalIn: 0, totalOut: 0, netProfit: 0, balance: 0 });
      }
    } catch (e) {
      setMsg({ type: 'err', text: 'Không tải được thu chi: ' + e.message });
    }
  };

  useEffect(() => {
    if (currentView === 'cash-book') { loadCashBook(); loadPurchaseReturns(); loadReturnOrders(); }
  }, [currentView]);

  const loadInventoryReport = async () => {
    const reqId = ++reportReqRef.current;
    try {
      let start = '2025-01-01';
      let end = '2030-12-31';
      const now = new Date();

      if (reportType === 'day') {
        const d = reportValue || now.toISOString().slice(0, 10);
        start = d;
        end = d;
      } else if (reportType === 'month') {
        // reportValue dạng '2025-01'
        const [y, m] = (reportValue || '2025-01').split('-');
        const lastDay = new Date(y, m, 0).getDate();
        start = `${y}-${m}-01`;
        end = `${y}-${m}-${lastDay}`;
      } else if (reportType === 'quarter') {
        const year = reportValue.split('-')[0] || '2025';
        const q = reportValue.split('-')[1] || 'Q1';
        if (q === 'Q1') { start = `${year}-01-01`; end = `${year}-03-31`; }
        else if (q === 'Q2') { start = `${year}-04-01`; end = `${year}-06-30`; }
        else if (q === 'Q3') { start = `${year}-07-01`; end = `${year}-09-30`; }
        else { start = `${year}-10-01`; end = `${year}-12-31`; }
      } else if (reportType === 'year') {
        const y = reportValue || '2025';
        start = `${y}-01-01`;
        end = `${y}-12-31`;
      } else if (reportType === 'custom') {
        start = reportStartDate || '2025-01-01';
        end = reportEndDate || '2030-12-31';
      }

      // Gọi API với ngày tháng chuẩn dạng YYYY-MM-DD
      const res = await api(`/api/reports/inventory-summary?startDate=${start}&endDate=${end}&search=${encodeURIComponent(reportSearch.trim())}`);

      // Có lần gọi mới hơn (ví dụ đang gõ tìm kiếm) thì bỏ qua kết quả này
      if (reqId !== reportReqRef.current) return;

      if (res && res.success) {
        // Chuẩn hóa dữ liệu: ép số, tránh null/undefined làm sập giao diện
        const n0 = (v) => Number(v) || 0;
        const rows = Array.isArray(res.items) ? res.items : [];
        setReportItems(rows.map((it, i) => ({
          id: it.id ?? i,
          code: String(it.code ?? ''),
          name: String(it.name ?? ''),
          unit: String(it.unit ?? ''),
          openingQty: n0(it.openingQty), openingVal: n0(it.openingVal),
          importQty: n0(it.importQty), importVal: n0(it.importVal),
          exportQty: n0(it.exportQty), exportVal: n0(it.exportVal),
          closingQty: n0(it.closingQty), closingVal: n0(it.closingVal),
        })));
        const sm = res.summary || {};
        setReportSummary({
          totalOpeningVal: n0(sm.totalOpeningVal),
          totalImportVal: n0(sm.totalImportVal),
          totalExportVal: n0(sm.totalExportVal),
          totalClosingVal: n0(sm.totalClosingVal),
        });
      }
    } catch (e) {
      console.error('Lỗi tải báo cáo:', e);
      setMsg({ type: 'err', text: 'Không tải được báo cáo: ' + e.message });
    }
  };

  // Gọi tự động khi chuyển sang view báo cáo
  useEffect(() => {
    if (currentView === 'inventory-report') {
      loadInventoryReport();
    }
  }, [currentView]);

  // Ô tìm kiếm sản phẩm: tự lọc lại báo cáo sau khi ngừng gõ 0,3 giây
  useEffect(() => {
    if (currentView !== 'inventory-report') return;
    const t = setTimeout(() => { loadInventoryReport(); }, 300);
    return () => clearTimeout(t);
  }, [reportSearch]);

  // ===== States cho Báo cáo Kết quả kinh doanh (Lãi / Lỗ) =====
  const [plReport, setPlReport] = useState(EMPTY_PL_REPORT);
  const [plStartDate, setPlStartDate] = useState('2025-01-01');
  const [plEndDate, setPlEndDate] = useState(todayLocal());

  const loadProfitLossReport = async () => {
    try {
      const res = await api(`/api/reports/profit-loss?startDate=${plStartDate}&endDate=${plEndDate}`);
      if (res && res.success) {
        const d = res.data || {};
        setPlReport({
          ...EMPTY_PL_REPORT,
          ...d,
          expenses: { ...EMPTY_PL_REPORT.expenses, ...(d.expenses || {}) },
        });
      } else {
        console.error('API trả về lỗi:', res);
      }
    } catch (err) {
      console.error('Lỗi kết nối API báo cáo:', err);
    }
  };

  // Quản lý thông tin doanh nghiệp & Logo (tự động lưu vào localStorage)
  const [companyInfo, setCompanyInfo] = useState(() => {
    try {
      const saved = localStorage.getItem('company_info');
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Không đọc được company_info:', e);
    }
    return {
      name: 'XE ĐIỆN LINH KHANG (LK EBIKE)',
      brand: 'LK EBIKE',
      subtitle: 'By BabyBikeStore',
      address: '767/10 Trần Hưng Đạo, Phường Chợ Quán, Tp.HCM',
      taxCode: '07918402804',
      phone: '0768 640 918',
      logoUrl: '' // Dán link ảnh logo vào đây hoặc để trống sẽ hiện chữ Brand
    };
  });

  const asArray = (d) => (Array.isArray(d) ? d : []);

  const loadData = () => {
    api('/api/products').then((d) => setProducts(asArray(d))).catch((e) => setMsg({ type: 'err', text: e.message }));
    api('/api/suppliers').then((d) => setSuppliers(asArray(d))).catch(() => {});
    api('/api/purchase_orders').then((d) => setPurchaseOrders(sortDesc(asArray(d)))).catch(() => {});
    api('/api/customers').then((d) => setCustomers(asArray(d))).catch(() => {});
    api('/api/invoices').then((d) => setInvoicesList(sortDesc(asArray(d)))).catch(() => {});
    api('/api/orders').then((d) => setOrdersList(sortDesc(asArray(d)))).catch(() => {});
  };

  useEffect(() => { loadData(); }, []);

  // Tự tắt thông báo sau 5 giây
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);

  // ===== Logic tạo đơn =====
  const cartLines = useMemo(
    () => products.filter((p) => cart[p.id]).map((p) => ({
      ...p,
      quantity: cart[p.id],
      price: cart[p.id + '_price'] !== undefined ? cart[p.id + '_price'] : p.price,
      discount: cart[p.id + '_discount'] || 0,
    })),
    [products, cart]
  );
  const cartTotal = cartLines.reduce((s, l) => s + ((l.price * l.quantity) - l.discount), 0);
  const cartDebt = Math.max(0, cartTotal - (Number(paidAmount) || 0));

  const openOrderModal = (type) => {
    setModalOrderType(type);
    setCart({});
    setPosCustomer({ name: '', phone: '', address: '' });
    setCustomerSearch('');
    setPosProductKeyword('');
    setPaidAmount(0);
    setPaymentMethod('Tiền mặt');
    setOrderDate(todayLocal());
    setShowOrderModal(true);
  };

  // Cho phép chỉnh sửa đơn giá linh hoạt trong giỏ hàng
  const add = (p) => {
    setCart((c) => {
      const next = { ...c, [p.id]: (c[p.id] || 0) + 1 };
      if (next[p.id + '_price'] === undefined) next[p.id + '_price'] = p.price;
      return next;
    });
  };

  const setItemPrice = (id, price) => setCart((c) => ({ ...c, [id + '_price']: Number(price) || 0 }));
  const setDiscount = (id, d) => setCart((c) => ({ ...c, [id + '_discount']: Number(d) || 0 }));

  const setQty = (id, q) =>
    setCart((c) => {
      const next = { ...c };
      if (q <= 0) {
        delete next[id];
        delete next[id + '_price'];
        delete next[id + '_discount'];
        delete next[id + '_chassis'];
        delete next[id + '_frame'];
        delete next[id + '_color'];
        delete next[id + '_note'];
      } else {
        next[id] = q;
      }
      return next;
    });

  const handleSelectOrderToInvoice = async (orderId) => {
    if (!orderId) return;
    try {
      const details = await api(`/api/orders/${orderId}`);
      // Điền thông tin khách hàng
      setPosCustomer({ name: details.customer_name, phone: details.customer_phone || '', address: details.address || '' });
      setCustomerSearch(details.customer_name);

      // Lấy số tiền đã cọc từ đơn đặt hàng làm mặc định đã thanh toán / tạm ứng
      setPaidAmount(details.paid_amount || 0);
      setDepositFromOrder(Number(details.paid_amount) || 0);

      // Đưa sản phẩm vào giỏ hàng
      const newCart = {};
      details.items.forEach(item => putItemIntoCart(newCart, item));
      setCart(newCart);
    } catch (e) {
      alert('Lỗi tải đơn đặt hàng: ' + e.message);
    }
  };

  async function handlePosSubmit() {
    setBusy(true); setMsg(null);
    try {
      const lines = products.filter((p) => cart[p.id]).map((p) => ({
        ...p,
        quantity: cart[p.id],
        price: cart[p.id + '_price'] !== undefined ? cart[p.id + '_price'] : p.price,
        discount: cart[p.id + '_discount'] || 0
      }));

      if (!posCustomer.name) throw new Error('Vui lòng chọn hoặc nhập tên khách hàng!');
      if (lines.length === 0) throw new Error('Giỏ hàng trống!');

      const body = {
        customer_name: posCustomer.name,
        customer_phone: posCustomer.phone,
        address: posCustomer.address,
        created_at: new Date(orderDate).toISOString(),
        payment_method: paymentMethod,
        paid_amount: Number(paidAmount) || 0,
        items: cartLines.map((l) => ({
          product_id: l.id,
          quantity: l.quantity,
          price: l.price,
          discount: l.discount,
          chassis_color: buildItemDetails(cart, l.id)
        }))
      };

      let r;
      let warrantyDraft = null;
      if (modalOrderType === 'orders' && editingOrderId) {
        // Nếu đang sửa đơn đặt hàng
        r = await api(`/api/orders/${editingOrderId}`, { method: 'PUT', body: JSON.stringify(body) });
        setMsg({ type: 'ok', text: `Đã cập nhật đơn đặt hàng ${r.code || ''} thành công!` });
      } else if (modalOrderType === 'invoices' && editingInvoiceId) {
        // Sửa phiếu: tồn khả dụng = tồn hiện tại + số lượng cũ của phiếu này
        for (const l of cartLines) {
          const available = (Number(l.stock) || 0) + (editingInvoiceOriginalQty[l.id] || 0);
          if (available < l.quantity) {
            throw new Error(`Sản phẩm "${l.name}" chỉ còn ${available} trong kho, không đủ xuất phiếu bán hàng!`);
          }
        }
        r = await api(`/api/invoices/${editingInvoiceId}`, { method: 'PUT', body: JSON.stringify(body) });
        setMsg({ type: 'ok', text: `Đã cập nhật phiếu bán hàng ${r.code || ''} thành công!` });
      } else {
        // Tạo mới
        if (modalOrderType === 'invoices') {
          for (const l of cartLines) {
            if (l.stock < l.quantity) {
              throw new Error(`Sản phẩm "${l.name}" chỉ còn ${l.stock} trong kho, không đủ xuất phiếu bán hàng!`);
            }
          }
        }
        r = await api(`/api/${modalOrderType}`, { method: 'POST', body: JSON.stringify(body) });
                // Fix: đơn đặt hàng mới tạo chưa lưu tạm ứng -> cập nhật lại chính đơn vừa tạo để lưu
        if (modalOrderType === 'orders' && (Number(paidAmount) || 0) > 0) {
          try {
            let newId = r.id;
            if (!newId) {
              const fresh = await api('/api/orders');
              newId = (asArray(fresh).find((o) => o.code === r.code) || {}).id;
            }
            if (newId) await api(`/api/orders/${newId}`, { method: 'PUT', body: JSON.stringify(body) });
          } catch (e) {
            console.error('Không lưu được tạm ứng cho đơn mới:', e);
          }
        }
        setMsg({ type: 'ok', text: `Tạo ${modalOrderType === 'invoices' ? 'phiếu bán hàng' : 'đơn đặt hàng'} ${r.code} thành công!` });

          if (modalOrderType === 'invoices') {
          // Lấy sẵn dữ liệu trước khi giỏ hàng bị xóa
          warrantyDraft = {
            invoice_code: r.code || '',
            customer_name: posCustomer.name,
            customer_phone: posCustomer.phone || '',
            address: posCustomer.address || '',
            purchase_date: orderDate,
            items: cartLines.map((l) => ({
              product_id: l.id, sku: l.sku || '', name: l.name, quantity: l.quantity, detail: buildItemDetails(cart, l.id),
            })),
          };
        }
        
      }

      setCart({});
      setPosCustomer({ name: '', phone: '', address: '' });
      setCustomerSearch('');
      setPaidAmount(0);
      setEditingOrderId(null);
      setEditingInvoiceId(null);
      setEditingInvoiceOriginalQty({});
      setShowOrderModal(false);
      loadData();
        if (warrantyDraft) {
        const draft = warrantyDraft;
        setTimeout(() => {
        if (window.confirm('Bạn có muốn tạo phiếu bảo hành cho phiếu bán hàng này không?')) openWarrantyModal(draft);
        }, 150);
      }
    } catch (e) {
      alert('Lỗi: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  const handleSaveInvoice = async () => {
    try {
      const url = editingInvoiceId ? `/api/invoices/${editingInvoiceId}` : '/api/invoices';
      const method = editingInvoiceId ? 'PUT' : 'POST';

      await api(url, {
        method,
        body: JSON.stringify(invoiceForm)
      });

      setShowInvoiceModal(false);
      setEditingInvoiceId(null);
      loadData(); // Tải lại danh sách (SỬA: trước đây gọi loadInvoices không tồn tại)
      alert(editingInvoiceId ? 'Cập nhật phiếu bán hàng thành công!' : 'Tạo phiếu bán hàng thành công!');
    } catch (err) {
      alert('Lỗi: ' + err.message);
    }
  };

  const handleOpenProductModal = async (product) => {
    setSelectedProduct(product);
    setActiveProductTab('info');
    setStockCardList([]);

    try {
      const res = await api(`/api/products/stock-card?productId=${product.id}`);
      if (res && res.success) {
        setStockCardList(res.data);
      }
    } catch (err) {
      console.error('Lỗi tải thẻ kho:', err);
    }
  };

  // === Hàm in phiếu / đơn ===
  const handlePrintOrder = async (item, isOrder = false) => {
    let printData = item;
    if (!item.items) {
      try {
        const type = isOrder ? 'orders' : 'invoices';
        printData = await api(`/api/${type}/${item.id}`);
      } catch (e) {
        alert('Không thể tải chi tiết để in: ' + e.message);
        return;
      }
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Vui lòng cho phép trình duyệt mở popup để in hóa đơn!');
      return;
    }

    const titleText = isOrder ? 'ĐƠN ĐẶT HÀNG' : 'HÓA ĐƠN BÁN HÀNG';
    const codeText = printData.code || '---';
    const dateText = printData.created_at ? new Date(printData.created_at).toLocaleDateString('vi-VN') : new Date().toLocaleDateString('vi-VN');
    const printPaymentMethod = printData.payment_method || 'Tiền mặt';

    const items = printData.items || [];
    let grossTotal = 0;
    let totalDiscount = 0;

    const itemsHtml = items.map((prod, index) => {
      const price = Number(prod.price) || 0;
      const qty = Number(prod.quantity) || 0;
      const discount = Number(prod.discount) || 0;
      const lineGross = price * qty;
      const lineNet = lineGross - discount;

      grossTotal += lineGross;
      totalDiscount += discount;

      const productName = prod.product_name || prod.name || 'Sản phẩm';
      const chassisText = prod.chassis_color
        ? `<div style="font-size: 11px; color: #555; font-style: italic; margin-top: 2px;">Số khung/sườn & Màu: ${prod.chassis_color}</div>`
        : '';

      return `
      <tr>
        <td style="text-align: center; padding: 8px; border-bottom: 1px solid #e2e8f0;">${index + 1}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">
          <div>${productName}</div>
          ${chassisText}
        </td>
        <td style="text-align: center; padding: 8px; border-bottom: 1px solid #e2e8f0;">${qty}</td>
        <td style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0;">${price.toLocaleString('vi-VN')}</td>
        <td style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0; color: #dc2626;">${discount > 0 ? discount.toLocaleString('vi-VN') : '0'}</td>
        <td style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${lineNet.toLocaleString('vi-VN')}</td>
      </tr>
    `;
    }).join('');

    const finalTotal = grossTotal - totalDiscount;
    const printPaidAmount = Number(printData.paid_amount) || 0;
    const debtAmount = finalTotal - printPaidAmount;

    // Logo chiếm 1/3 (33%), Thông tin công ty chiếm 2/3 (65%)
    const logoHtml = companyInfo.logoUrl
      ? `<img src="${companyInfo.logoUrl}" alt="Logo" style="width: 100%; height: 100%; object-fit: contain; display: block;" />`
      : `<div style="text-align: center;"><h1 style="margin: 0; color: #16a34a; font-style: italic; font-size: 28px; font-weight: 900;">${companyInfo.brand}</h1><p style="margin: 4px 0 0 0; color: #64748b; font-size: 13px; font-weight: bold;">${companyInfo.subtitle}</p></div>`;

    printWindow.document.write(`
      <html>
        <head>
          <title>${titleText} - ${codeText}</title>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; margin: 0; padding: 15px; font-size: 14px; }

            /* Thu nhỏ khoảng cách dưới header */
            .header { display: flex; justify-content: space-between; align-items: stretch; border-bottom: none; padding-bottom: 0px; margin-bottom: 5px; }

            .brand-left { width: 33%; border: none; padding: 0; background: transparent; display: flex; align-items: center; justify-content: flex-start; box-sizing: border-box; }
            .company-right { width: 65%; border: none; padding: 0; background: transparent; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
            .company-right h3 { margin: 0 0 4px 0; color: #2563eb; font-size: 16px; }
            .company-right p { margin: 2px 0; font-size: 12px; color: #475569; }

            /* Dịch phần tiêu đề sát lên trên, thêm đường viền gạch ngang ngay phía trên tiêu đề */
            .title-area { text-align: center; margin-top: 0px; margin-bottom: 15px; border-top: 2px solid #cbd5e1; padding-top: 8px; }
            .title-area h2 { margin: 0; font-size: 22px; text-transform: uppercase; color: #0f172a; }
            .title-area p { margin: 3px 0 0 0; color: #64748b; font-size: 13px; }
            .info-grid { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            th { background: #f1f5f9; padding: 10px 8px; text-align: left; font-size: 13px; border-bottom: 2px solid #cbd5e1; }
            .totals { width: 350px; margin-left: auto; margin-bottom: 40px; font-size: 13px; }
            .totals div { display: flex; justify-content: space-between; padding: 5px 0; }
            .totals .final { border-top: 2px solid #0f172a; font-weight: bold; font-size: 15px; color: #dc2626; padding-top: 8px; margin-top: 5px; }
            .signatures { display: flex; justify-content: space-between; text-align: center; margin-top: 30px; font-weight: bold; }
            .signatures div { width: 200px; }
            .signatures p { font-weight: normal; font-size: 12px; color: #64748b; font-style: italic; margin-top: 4px; }
            .footer { text-align: center; font-style: italic; color: #64748b; font-size: 12px; margin-top: 50px; border-top: 1px dashed #cbd5e1; padding-top: 15px; }
            @media print { body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="brand-left">
              ${logoHtml}
            </div>
            <div class="company-right">
              <h3>${companyInfo.name}</h3>
              <p><b>Địa chỉ:</b> ${companyInfo.address}</p>
              <p><b>MST:</b> ${companyInfo.taxCode} | <b>SĐT:</b> ${companyInfo.phone}</p>
            </div>
          </div>

          <div class="title-area">
            <h2>${titleText}</h2>
            <p>Mã chứng từ: <b>${codeText}</b> &nbsp;|&nbsp; Ngày lập: ${dateText}</p>
          </div>

          <div class="info-grid">
            <div>
              <p><b>Khách hàng:</b> ${printData.customer_name || 'Khách lẻ'}</p>
              <p><b>Địa chỉ:</b> ${printData.address || '—'}</p>
              <p><b>SĐT:</b> ${printData.customer_phone || '—'}</p>
            </div>
            <div>
              <p><b>Hình thức TT:</b> ${printPaymentMethod}</p>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th style="width: 40px; text-align: center;">STT</th>
                <th>Tên sản phẩm</th>
                <th style="width: 50px; text-align: center;">SL</th>
                <th style="width: 90px; text-align: right;">Đơn giá</th>
                <th style="width: 90px; text-align: right;">Giảm giá</th>
                <th style="width: 100px; text-align: right;">Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>

          <div class="totals">
            <div><span>Tổng cộng:</span> <b>${grossTotal.toLocaleString('vi-VN')} ₫</b></div>
            <div><span>Giảm giá tổng:</span> <b style="color: #dc2626;">-${totalDiscount.toLocaleString('vi-VN')} ₫</b></div>
            <div><span>Đã thanh toán / Tạm ứng:</span> <b>${printPaidAmount.toLocaleString('vi-VN')} ₫</b></div>
            <div class="final"><span>Còn nợ lại:</span> <span>${debtAmount.toLocaleString('vi-VN')} ₫</span></div>
          </div>

          <div class="signatures">
            <div>
              <b>Người lập phiếu</b>
              <p>(Ký, ghi rõ họ tên)</p>
            </div>
            <div>
              <b>Khách hàng</b>
              <p>(Ký, ghi rõ họ tên)</p>
            </div>
          </div>

          <div class="footer">
            Cảm ơn quý khách và hẹn gặp lại!
          </div>

          <script>
    // Thêm độ trễ 400ms để trình duyệt trên điện thoại kịp render nội dung trước khi gọi lệnh in
    window.onload = function() {
      setTimeout(function() {
        window.print();
      }, 400);
    };
  </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // 1. Hàm xem chi tiết đơn đặt hàng hoặc phiếu bán hàng
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailData, setDetailData] = useState(null);

  const handleViewDetail = async (type, id) => {
    try {
      const data = await api(`/api/${type}/${id}`);
      setDetailData(data);
      setShowDetailModal(true);
    } catch (e) {
      alert('Lỗi tải chi tiết: ' + e.message);
    }
  };

  // 2. Hàm chỉnh sửa đơn đặt hàng (nạp lại vào popup)
  const handleEditOrder = async (ord) => {
    try {
      const details = await api(`/api/orders/${ord.id}`);
      setEditingInvoiceId(null);
      setEditingInvoiceOriginalQty({});
      setEditingOrderId(ord.id); // Lưu lại ID để biết đang sửa đơn này
      setModalOrderType('orders');
      setPosCustomer({ name: details.customer_name, phone: details.customer_phone || '', address: details.address || '' });
      setCustomerSearch(details.customer_name);
      setPaidAmount(details.paid_amount || 0);
      setPaymentMethod(details.payment_method || 'Tiền mặt');
      setOrderDate(details.created_at ? details.created_at.split('T')[0] : todayLocal());

      const newCart = {};
      details.items.forEach(item => putItemIntoCart(newCart, item));
      setCart(newCart);
      setShowOrderModal(true);
    } catch (e) {
      alert('Lỗi khi tải dữ liệu sửa đơn: ' + e.message);
    }
  };

  // 2b. Hàm chỉnh sửa phiếu bán hàng (nạp lại vào popup tạo đơn)
  const handleEditInvoice = async (inv) => {
    try {
      const details = await api(`/api/invoices/${inv.id}`);
      setEditingOrderId(null);
      setEditingInvoiceId(inv.id);
      setModalOrderType('invoices');
      setPosCustomer({ name: details.customer_name, phone: details.customer_phone || '', address: details.address || '' });
      setCustomerSearch(details.customer_name);
      setPaidAmount(details.paid_amount || 0);
      setPaymentMethod(details.payment_method || 'Tiền mặt');
      setOrderDate(details.created_at ? details.created_at.split('T')[0] : todayLocal());
      setPosProductKeyword('');

      const newCart = {};
      const oldQty = {};
      (details.items || []).forEach((item) => {
        putItemIntoCart(newCart, item); // tách đúng số khung / sườn / màu / ghi chú
        oldQty[item.product_id] = item.quantity;
      });
      setCart(newCart);
      setEditingInvoiceOriginalQty(oldQty);
      setShowOrderModal(true);
    } catch (e) {
      alert('Lỗi khi tải dữ liệu sửa phiếu: ' + e.message);
    }
  };

  // 3. Hàm xóa đơn đặt hàng hoặc phiếu bán hàng
  const handleDeleteOrderOrInvoice = async (type, id, code) => {
    if (!confirm(`Bạn có chắc muốn xóa ${type === 'orders' ? 'đơn đặt hàng' : 'phiếu bán hàng'} ${code}?`)) return;
    try {
      await api(`/api/${type}/${id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `Đã xóa ${code} thành công!` });
      loadData();
    } catch (e) {
      alert('Lỗi khi xóa: ' + e.message);
    }
  };

  // ===== Quản lý Sản phẩm =====
  const handleSaveProduct = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...productForm,
        import_price: Number(productForm.import_price) || 0,
        price: Number(productForm.price) || 0,
        wholesale_price: Number(productForm.wholesale_price) || 0,
        stock: Number(productForm.stock) || 0,
      };
      if (editingProduct) {
        await api(`/api/products/${editingProduct.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg({ type: 'ok', text: 'Đã cập nhật sản phẩm thành công!' });
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
        setMsg({ type: 'ok', text: 'Đã thêm sản phẩm thành công!' });
      }
      setShowProductModal(false);
      setEditingProduct(null);
      setProductForm(EMPTY_PRODUCT);
      loadData();
    } catch (err) {
      alert('Lỗi: ' + err.message);
      setMsg({ type: 'err', text: err.message });
    }
  };

  const handleDeleteProduct = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa sản phẩm này?')) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: 'Đã xóa sản phẩm thành công' });
      loadData();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  };

  // ===== Quản lý Nhà cung cấp =====
    const openSupplierDetail = async (s) => {
    setSelectedSupplier(s);
    setEditingSupplier(s);
    setSupplierForm({ code: s.code, name: s.name, phone: s.phone || '', address: s.address || '', status: s.status });
    setSupplierTab('info');
    setSupplierCashItems([]);
    setSupplierPrList([]);
    try {
      const hist = await api(`/api/suppliers/${s.id}/history`);
      setSupplierHistory({ ...hist, purchases: sortDesc(hist.purchases || []) });
    } catch (e) {
      setSupplierHistory({ purchases: [], payments: [], returns: [] });
    }
    // Lấy thêm sổ thu chi + phiếu trả hàng nhập để dựng tab thanh toán / trả hàng
    try {
      const cb = await api('/api/cash-book');
      setSupplierCashItems(cb.items || []);
    } catch (e) { /* bỏ qua */ }
    try {
      const pr = await api('/api/purchase-returns');
      const list = Array.isArray(pr?.data?.list) ? pr.data.list : [];
      setSupplierPrList(list.filter((r) => String(r.supplier_id) === String(s.id)));
    } catch (e) { /* bỏ qua */ }
    setShowSupplierModal(true);
  };

  // ----- Hỗ trợ cho các tab lịch sử của NCC -----
  const fmtDT = (v) => (v ? new Date(v).toLocaleString('vi-VN') : '---');
  const smallBtn = (bg, color) => ({ background: bg, color, border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' });

  // Mở form sửa phiếu thu chi (giống nút ✏️ trong màn hình Thu chi)
  const openEditCash = (item) => {
    setEditingCashId(item.id);
    setCashForm({
      type: item.type,
      amount: item.amount,
      category: item.category,
      payment_method: item.payment_method || 'Chuyển khoản',
      reference_code: item.reference_code || '',
      note: item.note || '',
      created_at: item.created_at ? item.created_at.slice(0, 10) : todayLocal(),
    });
    setShowCashModal(true);
  };

  // Đóng popup NCC rồi mở popup xem / sửa (để popup mới không bị che)
  const viewPurchaseFromSupplier = async (p) => {
    try {
      const d = await api(`/api/purchase_orders/${p.id}`);
      setSelectedPurchaseOrder(d);
      setShowSupplierModal(false);
      setShowViewPurchaseModal(true);
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  };
  const editPurchaseFromSupplier = (p) => { setShowSupplierModal(false); openEditPurchase(p); };
  const viewReturnFromSupplier = (r) => { setShowSupplierModal(false); handleViewPr(r); };
  const editReturnFromSupplier = (r) => { setShowSupplierModal(false); handleEditPr(r); };

  // Gom lịch sử thanh toán của NCC đang xem từ: sổ thu chi, tiền đã trả trên phiếu nhập, tiền đã thu lại trên phiếu trả
  const getSupplierPaymentRows = () => {
    if (!selectedSupplier) return [];
    const sup = selectedSupplier;
    const supName = removeAccents(sup.name);
    const pos = supplierHistory.purchases || [];
    const codes = new Set([...pos.map((p) => p.code), ...supplierPrList.map((r) => r.code)]);
    const usedCodes = new Set();
    const rows = [];

    supplierCashItems.forEach((c) => {
      const ref = c.reference_code || '';
      const hit = codes.has(ref) || (ref && ref === sup.code) || (supName && c.note && removeAccents(c.note).includes(supName));
      if (!hit) return;
      if (codes.has(ref)) usedCodes.add(ref);
      rows.push({ key: 'c' + c.id, date: c.created_at, code: c.code, type: c.type, amount: Number(c.amount) || 0, method: c.payment_method, note: c.note || c.reference_code || '', kind: 'cash', ref: c });
    });

    pos.forEach((p) => {
      const full = (purchaseOrders || []).find((x) => x.id === p.id) || p;
      const paid = Number(full.paid_amount) || 0;
      if (paid > 0 && !usedCodes.has(p.code)) {
        rows.push({ key: 'p' + p.id, date: full.created_at || p.created_at, code: p.code, type: 'OUT', amount: paid, method: full.payment_method || '', note: 'Thanh toán khi nhập hàng', kind: 'po', ref: p });
      }
    });

    supplierPrList.forEach((r) => {
      const got = Number(r.refund_received ?? r.received_amount) || 0;
      if (got > 0 && !usedCodes.has(r.code)) {
        rows.push({ key: 'r' + r.id, date: r.return_date, code: r.code, type: 'IN', amount: got, method: r.payment_method || '', note: 'Thu tiền hoàn từ NCC (trả hàng nhập)', kind: 'pr', ref: r });
      }
    });

    (supplierHistory.payments || []).forEach((pay) => {
      const amt = Number(pay.amount) || 0;
      const d = String(pay.created_at || '').slice(0, 10);
      if (rows.some((r) => r.amount === amt && String(r.date || '').slice(0, 10) === d)) return; // đã có rồi, bỏ trùng
      rows.push({ key: 'h' + pay.id, date: pay.created_at, code: pay.code || `TT-${pay.id}`, type: 'OUT', amount: amt, method: pay.method || '', note: pay.note || '', kind: 'none', ref: null });
    });

    return rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  };

  const viewPaymentRow = (r) => {
    if (r.kind === 'cash') { setShowSupplierModal(false); setSelectedCashItem(r.ref); }
    else if (r.kind === 'po') viewPurchaseFromSupplier(r.ref);
    else if (r.kind === 'pr') viewReturnFromSupplier(r.ref);
  };
  const editPaymentRow = (r) => {
    if (r.kind === 'cash') { setShowSupplierModal(false); openEditCash(r.ref); }
    else if (r.kind === 'po') editPurchaseFromSupplier(r.ref);
    else if (r.kind === 'pr') editReturnFromSupplier(r.ref);
  };

  const handleSaveSupplier = async (e) => {
    e.preventDefault();
    try {
      if (editingSupplier) {
        await api(`/api/suppliers/${editingSupplier.id}`, { method: 'PUT', body: JSON.stringify(supplierForm) });
        setMsg({ type: 'ok', text: 'Đã cập nhật nhà cung cấp thành công' });
      } else {
        await api('/api/suppliers', { method: 'POST', body: JSON.stringify(supplierForm) });
        setMsg({ type: 'ok', text: 'Đã thêm nhà cung cấp mới thành công' });
      }
      setShowSupplierModal(false);
      setSupplierForm(EMPTY_SUPPLIER);
      setEditingSupplier(null);
      loadData();
    } catch (err) {
      alert('Lỗi: ' + err.message);
      setMsg({ type: 'err', text: err.message });
    }
  };

  const handleDeleteSupplier = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa nhà cung cấp này?')) return;
    try {
      await api(`/api/suppliers/${id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: 'Đã xóa nhà cung cấp' });
      setShowSupplierModal(false);
      loadData();
    } catch (e) {
      alert('Lỗi: ' + e.message);
      setMsg({ type: 'err', text: e.message });
    }
  };

  // ===== Khách hàng =====
  const handleSaveCustomer = async (e) => {
    e.preventDefault();
    try {
      if (editingCustomer) {
        await api(`/api/customers/${editingCustomer.id}`, { method: 'PUT', body: JSON.stringify(customerForm) });
        setMsg({ type: 'ok', text: 'Đã cập nhật khách hàng thành công!' });
      } else {
        await api('/api/customers', { method: 'POST', body: JSON.stringify(customerForm) });
        setMsg({ type: 'ok', text: 'Đã thêm khách hàng mới thành công!' });
        // Nếu thêm từ popup tạo đơn thì chọn luôn khách vừa tạo
        if (showOrderModal) {
          setPosCustomer({ name: customerForm.name, phone: customerForm.phone || '', address: customerForm.address || '' });
          setCustomerSearch(customerForm.name);
          setShowCustomerDropdown(false);
        }
      }
      setShowCustomerModal(false);
      setEditingCustomer(null);
      setCustomerForm(EMPTY_CUSTOMER);
      loadData();
    } catch (err) {
      alert('Lỗi: ' + err.message);
      setMsg({ type: 'err', text: err.message });
    }
  };

  const handleDeleteCustomer = async (id, name) => {
    if (!confirm(`Bạn có chắc muốn xóa khách hàng ${name}?`)) return;
    try {
      await api(`/api/customers/${id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `Đã xóa khách hàng ${name} thành công!` });
      setShowCustomerDetailModal(false);
      loadData();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  };

    const openCustomerDetail = async (c) => {
    setSelectedCustomerDetail(c);
    setCustomerDetailTab('orders');
    setCustomerCashItems([]);
    setCustomerReturnList([]);
    try {
      const data = await api(`/api/customers/${c.id}/history`);
      setCustomerDetailData({ invoices: data.invoices || [], payments: data.payments || [] });
    } catch (e) {
      setCustomerDetailData({ invoices: [], payments: [] });
    }
    try {
      const cb = await api('/api/cash-book');
      setCustomerCashItems(cb.items || []);
    } catch (e) { /* bỏ qua */ }
    try {
      const ro = await api('/api/return-orders');
      const list = Array.isArray(ro?.data?.list) ? ro.data.list : [];
      setCustomerReturnList(list.filter((r) => r.customer_name === c.name));
    } catch (e) { /* bỏ qua */ }
    setShowCustomerDetailModal(true);
  };

  // ----- Hỗ trợ cho các tab trong popup khách hàng -----
  const isOrderCode = (code) => String(code || '').startsWith('DH');
  const viewCustInvoice = (inv) => handleViewDetail(isOrderCode(inv.code) ? 'orders' : 'invoices', inv.id);
  const editCustInvoice = (inv) => (isOrderCode(inv.code) ? handleEditOrder(inv) : handleEditInvoice(inv));

  // Gom lịch sử thanh toán của khách từ: sổ thu chi, tiền đã trả trên phiếu bán, tạm ứng đơn đặt hàng, tiền hoàn trả hàng
  const getCustomerPaymentRows = () => {
    const cus = selectedCustomerDetail;
    if (!cus) return [];
    const cusName = removeAccents(cus.name);
    const invs = customerDetailData.invoices || [];
    const ords = (ordersList || []).filter((o) => o.customer_name === cus.name);
    const rets = customerReturnList;
    const codes = new Set([...invs.map((i) => i.code), ...ords.map((o) => o.code), ...rets.map((r) => r.code)]);
    const usedCodes = new Set();
    const rows = [];

    customerCashItems.forEach((c) => {
      const ref = c.reference_code || '';
      const hit = codes.has(ref) || (ref && ref === cus.code) || (cusName.length >= 4 && c.note && removeAccents(c.note).includes(cusName));
      if (!hit) return;
      if (codes.has(ref)) usedCodes.add(ref);
      rows.push({ key: 'c' + c.id, date: c.created_at, code: c.code, type: c.type, amount: Number(c.amount) || 0, method: c.payment_method, note: c.note || c.reference_code || '', kind: 'cash', ref: c });
    });

    invs.forEach((i) => {
      const paid = Number(i.paid_amount) || 0;
      if (paid > 0 && !usedCodes.has(i.code) && !isOrderCode(i.code)) {
        rows.push({ key: 'i' + i.id, date: i.created_at, code: i.code, type: 'IN', amount: paid, method: i.payment_method || '', note: 'Thanh toán khi bán hàng', kind: 'inv', ref: i });
      }
    });

    ords.forEach((o) => {
      const paid = Number(o.paid_amount) || 0;
      if (paid > 0 && !usedCodes.has(o.code)) {
        rows.push({ key: 'o' + o.id, date: o.created_at, code: o.code, type: 'IN', amount: paid, method: o.payment_method || '', note: 'Tạm ứng đơn đặt hàng', kind: 'ord', ref: o });
      }
    });

    rets.forEach((r) => {
      const amt = Number(r.refund_amount) || 0;
      if (amt > 0 && isDoneReturn(r.status) && !usedCodes.has(r.code)) {
        rows.push({ key: 'r' + r.id, date: r.return_date, code: r.code, type: 'OUT', amount: amt, method: r.payment_method || '', note: 'Hoàn tiền trả hàng', kind: 'ret', ref: r });
      }
    });

    (customerDetailData.payments || []).forEach((pay) => {
      const amt = Number(pay.amount) || 0;
      const d = String(pay.created_at || '').slice(0, 10);
      if (rows.some((r) => r.amount === amt && String(r.date || '').slice(0, 10) === d)) return; // đã có rồi, bỏ trùng
      rows.push({ key: 'h' + pay.id, date: pay.created_at, code: pay.code || `GD-${pay.id}`, type: 'IN', amount: amt, method: pay.method || '', note: pay.note || '', kind: 'none', ref: null });
    });

    return rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  };

  const viewCustPaymentRow = (r) => {
    if (r.kind === 'cash') setSelectedCashItem(r.ref);
    else if (r.kind === 'inv') handleViewDetail('invoices', r.ref.id);
    else if (r.kind === 'ord') handleViewDetail('orders', r.ref.id);
    else if (r.kind === 'ret') { setShowCustomerDetailModal(false); setCurrentView('return-orders'); loadReturnOrders(); handleViewReturn(r.ref); }
  };
  const editCustPaymentRow = (r) => {
    if (r.kind === 'cash') openEditCash(r.ref);
    else if (r.kind === 'inv') handleEditInvoice(r.ref);
    else if (r.kind === 'ord') handleEditOrder(r.ref);
    else if (r.kind === 'ret') { setShowCustomerDetailModal(false); setCurrentView('return-orders'); loadReturnOrders(); handleEditReturn(r.ref); }
  };

  // ===== Phiếu nhập =====
  const handleDeletePurchaseOrder = async (id, code) => {
    if (!confirm(`Bạn có chắc muốn xóa phiếu nhập ${code}? Thao tác này sẽ hoàn lại số lượng tồn kho!`)) return;
    try {
      await api(`/api/purchase_orders/${id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `Đã xóa phiếu nhập ${code} thành công!` });
      loadData();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  };

  const openCreatePurchase = () => {
    setEditingPurchaseId(null);
    setPurchaseItems([]);
    setPurchaseForm({
      supplier_id: '',
      payment_method: 'Tiền mặt',
      paid_amount: 0,
      created_at: nowLocalISO().slice(0, 16) // Khởi tạo ngày giờ hiện tại
    });
    setSupplierSearchKeyword('');
    setProductSearchKeyword('');
    setShowCreatePurchaseModal(true);
  };

  const openEditPurchase = async (po) => {
    try {
      const details = await api(`/api/purchase_orders/${po.id}`);
      setEditingPurchaseId(po.id);
      setPurchaseForm({
        supplier_id: details.supplier_id,
        payment_method: details.payment_method || 'Tiền mặt',
        paid_amount: details.paid_amount || 0,
        // Nạp ngày nhập cũ vào form để khi lưu không bị ghi đè thành ngày hiện tại
        created_at: details.created_at ? details.created_at.slice(0, 16) : nowLocalISO().slice(0, 16),
      });
      setPurchaseItems((details.items || []).map((i) => ({
        product_id: i.product_id,
        name: i.product_name,
        sku: i.sku,
        unit: i.unit || 'Cái',
        quantity: i.quantity,
        price: i.price,
        discount: i.discount || 0,
      })));
      const foundSup = (suppliers || []).find((s) => s.id === details.supplier_id);
      setSupplierSearchKeyword(foundSup ? `${foundSup.name} (${foundSup.code})` : '');
      setProductSearchKeyword('');
      setShowCreatePurchaseModal(true);
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  };

  const handleSavePurchase = async () => {
    if (!purchaseForm.supplier_id) return alert('Vui lòng chọn nhà cung cấp!');
    if (purchaseItems.length === 0) return alert('Vui lòng chọn sản phẩm nhập kho!');
    try {
      const url = editingPurchaseId ? `/api/purchase_orders/${editingPurchaseId}` : '/api/purchase_orders';
      await api(url, {
        method: editingPurchaseId ? 'PUT' : 'POST',
        body: JSON.stringify({
          supplier_id: purchaseForm.supplier_id,
          payment_method: purchaseForm.payment_method,
          paid_amount: Number(purchaseForm.paid_amount) || 0,
          created_at: purchaseForm.created_at, // Gửi chính xác giá trị ngày chọn từ input datetime-local lên
          items: purchaseItems,
        }),
      });
      setMsg({ type: 'ok', text: editingPurchaseId ? 'Cập nhật phiếu nhập thành công!' : 'Lưu phiếu nhập hàng thành công!' });
      setShowCreatePurchaseModal(false);
      setEditingPurchaseId(null);
      loadData();
    } catch (err) {
      alert('Lỗi: ' + err.message);
    }
  };

  // ===== Thêm nhanh nhà cung cấp (trong popup phiếu nhập) =====
  const [showQuickAddSupplierModal, setShowQuickAddSupplierModal] = useState(false);
  const [newSupplierForm, setNewSupplierForm] = useState({ name: '', phone: '', address: '' });

  const handleQuickSaveSupplier = async () => {
    if (!newSupplierForm.name) return alert('Vui lòng nhập tên nhà cung cấp!');
    try {
      const res = await api('/api/suppliers', {
        method: 'POST',
        body: JSON.stringify(newSupplierForm)
      });
      if (res && res.success) {
        alert('Thêm nhà cung cấp thành công!');
        setShowQuickAddSupplierModal(false);
        setNewSupplierForm({ name: '', phone: '', address: '' });
        // Tự động chọn luôn nhà cung cấp vừa tạo vào form mua hàng
        if (res.id) {
          setPurchaseForm((f) => ({ ...f, supplier_id: res.id }));
          setSupplierSearchKeyword(newSupplierForm.name);
        }
        loadData(); // Tải lại danh sách
      }
    } catch (err) {
      alert('Lỗi thêm nhà cung cấp: ' + err.message);
    }
  };

  const updatePurchaseItem = (index, patch) =>
    setPurchaseItems((items) => items.map((it, idx) => (idx === index ? { ...it, ...patch } : it)));

  // ===== Import =====
  const runImport = async ({ text, endpoint, mapRow, label, close }) => {
    try {
      const items = text.split('\n').map((l) => l.trim()).filter(Boolean).map(splitRow).map(mapRow).filter(Boolean);
      if (items.length === 0) {
        alert('Không đọc được dữ liệu hợp lệ! Vui lòng kiểm tra lại định dạng (cột cách nhau bằng Tab hoặc dấu ;).');
        return;
      }
      const res = await api(endpoint, { method: 'POST', body: JSON.stringify({ items }) });
      setMsg({ type: 'ok', text: `Nhập thành công ${res.successCount ?? items.length} ${label}!` });
      close(false);
      loadData();
    } catch (err) {
      alert('Lỗi chi tiết: ' + err.message);
    }
  };

  // Sắp xếp sản phẩm theo mã SKU A→Z (số trong mã được so sánh đúng thứ tự: SP2 trước SP10)
const sortedProducts = useMemo(
  () =>
    [...(products || [])].sort((a, b) => {
      const sa = (a.sku || '').trim();
      const sb = (b.sku || '').trim();
      if (!sa && !sb) return (a.name || '').localeCompare(b.name || '', 'vi');
      if (!sa) return 1; // sản phẩm chưa có mã xuống cuối
      if (!sb) return -1;
      return sa.localeCompare(sb, 'vi', { numeric: true, sensitivity: 'base' });
    }),
  [products]
);
const productKeyword = removeAccents(productListSearch.trim());
const visibleProducts = productKeyword
  ? sortedProducts.filter((p) => removeAccents(p.sku).includes(productKeyword) || removeAccents(p.name).includes(productKeyword))
  : sortedProducts;
const productSuggestions = productKeyword ? visibleProducts.slice(0, 8) : [];

    // Sắp xếp NCC theo mã A→Z (số trong mã so đúng thứ tự: NCC2 trước NCC10) + lọc theo tên / mã / SĐT
  const sortedSuppliers = useMemo(
    () =>
      [...(suppliers || [])].sort((a, b) =>
        (a.code || '').trim().localeCompare((b.code || '').trim(), 'vi', { numeric: true, sensitivity: 'base' })
      ),
    [suppliers]
  );
  const supplierKeyword = removeAccents(supplierListSearch.trim());
  const supplierPhoneKeyword = supplierListSearch.trim().replace(/[\s.]/g, '');
  const visibleSuppliers = supplierKeyword
    ? sortedSuppliers.filter(
        (s) =>
          removeAccents(s.name).includes(supplierKeyword) ||
          removeAccents(s.code).includes(supplierKeyword) ||
          (supplierPhoneKeyword && String(s.phone || '').replace(/[\s.]/g, '').includes(supplierPhoneKeyword))
      )
    : sortedSuppliers;

      // Khoảng ngày theo bộ lọc (null = tất cả thời gian)
  const supRange = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    if (supPeriod === 'month' && supMonth) {
      const [y, m] = supMonth.split('-');
      return [`${y}-${m}-01`, `${y}-${m}-${pad(new Date(Number(y), Number(m), 0).getDate())}`];
    }
    if (supPeriod === 'quarter' && supYear) {
      const sm = (Number(supQuarter) - 1) * 3 + 1;
      const em = sm + 2;
      return [`${supYear}-${pad(sm)}-01`, `${supYear}-${pad(em)}-${pad(new Date(Number(supYear), em, 0).getDate())}`];
    }
    if (supPeriod === 'year' && supYear) return [`${supYear}-01-01`, `${supYear}-12-31`];
    if (supPeriod === 'custom') return [supFrom || '0000-00-00', supTo || '9999-12-31'];
    return null;
  })();
  const rangeStart = supRange ? supRange[0] : '';
  const rangeEnd = supRange ? supRange[1] : '';

  // Tổng nhập / đã trả / nợ của từng NCC trong khoảng đã lọc (tính từ các phiếu nhập)
  const supplierStats = useMemo(() => {
    const map = {};
    (purchaseOrders || []).forEach((po) => {
      const d = String(po.created_at || '').slice(0, 10);
      if (rangeStart && (d < rangeStart || d > rangeEnd)) return;
      const total = Number(po.total) || 0;
      const paid = Number(po.paid_amount) || 0;
      const debt = po.debt !== undefined && po.debt !== null ? Number(po.debt) : total - paid;
      const m = map[po.supplier_id] || (map[po.supplier_id] = { total: 0, paid: 0, debt: 0, count: 0 });
      m.total += total; m.paid += paid; m.debt += debt; m.count += 1;
    });
    return map;
  }, [purchaseOrders, rangeStart, rangeEnd]);

  // Dòng hiển thị: không lọc thời gian thì dùng số của server, có lọc thì dùng số tính theo kỳ
  const supplierRows = visibleSuppliers
    .filter((s) => !supRange || supplierStats[s.id])
    .map((s) => {
      if (!supRange) return { ...s, f_total: Number(s.total_purchase) || 0, f_paid: Number(s.total_paid) || 0, f_debt: Number(s.total_debt) || 0 };
      const st = supplierStats[s.id];
      return { ...s, f_total: st.total, f_paid: st.paid, f_debt: st.debt };
    });
  const supplierSums = supplierRows.reduce(
    (a, s) => ({ total: a.total + s.f_total, paid: a.paid + s.f_paid, debt: a.debt + s.f_debt }),
    { total: 0, paid: 0, debt: 0 }
  );

    const anyChildOpen = !!(showViewPurchaseModal || showCreatePurchaseModal || showPrModal || prDetail || showCashModal || selectedCashItem);
  useEffect(() => {
    if (anyChildOpen) setShowSupplierModal(false);
  }, [anyChildOpen]);

    // Tìm NCC / KH liên quan tới 1 phiếu thu chi (dựa vào ô chứng từ liên quan)
    const getCashPartner = (item) => {
    const ref = String(item.reference_code || '').trim();
    if (!ref) return null;
    const asSup = (s) => (s ? { code: s.code, name: s.name, kind: 'ncc' } : null);
    const asCus = (c) => (c ? { code: c.code, name: c.name, kind: 'kh' } : null);
    const supById = (id) => (suppliers || []).find((s) => String(s.id) === String(id));
    const cusByName = (n) => (customers || []).find((c) => c.name === n);

    const direct = asSup((suppliers || []).find((s) => s.code === ref)) || asCus((customers || []).find((c) => c.code === ref));
    if (direct) return direct;

    const po = (purchaseOrders || []).find((p) => p.code === ref);
    if (po) return asSup(supById(po.supplier_id));
    const pr = (prData.list || []).find((r) => r.code === ref);
    if (pr) return asSup(supById(pr.supplier_id));

    const inv = (invoicesList || []).find((i) => i.code === ref) || (ordersList || []).find((o) => o.code === ref);
    if (inv) return asCus((customers || []).find((c) => String(c.id) === String(inv.customer_id)) || cusByName(inv.customer_name));
    const ro = (returnOrdersData.list || []).find((r) => r.code === ref);
    if (ro) return asCus(cusByName(ro.customer_name));
    return null;
  };

      // Khoảng ngày theo bộ lọc Thu chi (null = tất cả thời gian)
  const cashRange = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    if (cashPeriod === 'month' && cashMonth) {
      const [y, m] = cashMonth.split('-');
      return [`${y}-${m}-01`, `${y}-${m}-${pad(new Date(Number(y), Number(m), 0).getDate())}`];
    }
    if (cashPeriod === 'quarter' && cashYear) {
      const sm = (Number(cashQuarter) - 1) * 3 + 1;
      const em = sm + 2;
      return [`${cashYear}-${pad(sm)}-01`, `${cashYear}-${pad(em)}-${pad(new Date(Number(cashYear), em, 0).getDate())}`];
    }
    if (cashPeriod === 'year' && cashYear) return [`${cashYear}-01-01`, `${cashYear}-12-31`];
    if (cashPeriod === 'custom') return [cashFrom || '0000-00-00', cashTo || '9999-12-31'];
    return null;
  })();

  // Lọc phiếu: theo thời gian + từ khóa (mã GD, mã/tên NCC-KH, chứng từ, danh mục, ghi chú)
  const cashKeyword = removeAccents(cashSearch.trim());
  const visibleCashItems = (cashItems || []).filter((item) => {
    if (cashRange) {
      const d = String(item.created_at || '').slice(0, 10);
      if (d < cashRange[0] || d > cashRange[1]) return false;
    }
    if (!cashKeyword) return true;
    const pt = getCashPartner(item);
    const hay = removeAccents(
      [item.code, item.reference_code, item.category, item.note, item.payment_method, pt ? pt.code : '', pt ? pt.name : ''].join(' ')
    );
    return hay.includes(cashKeyword);
  });

  // 4 ô KPI: không lọc thì dùng số của server; có lọc thì tính theo các phiếu đang hiện
  const cashFiltering = !!(cashRange || cashKeyword);
  const cashSums = cashFiltering
    ? (() => {
        const tin = visibleCashItems.filter((i) => i.type === 'IN').reduce((s, i) => s + (Number(i.amount) || 0), 0);
        const tout = visibleCashItems.filter((i) => i.type !== 'IN').reduce((s, i) => s + (Number(i.amount) || 0), 0);
        return { totalIn: tin, totalOut: tout, netProfit: tin - tout, balance: Number(cashSummary.balance) || 0 };
      })()
    : cashSummary;

    // Sắp xếp khách hàng theo mã A→Z (số trong mã so đúng thứ tự: KH2 trước KH10)
  const sortedCustomers = useMemo(
    () =>
      [...(customers || [])].sort((a, b) =>
        (a.code || '').trim().localeCompare((b.code || '').trim(), 'vi', { numeric: true, sensitivity: 'base' })
      ),
    [customers]
  );

    // Lọc khách hàng theo tên / mã KH / SĐT (gõ không dấu cũng tìm được)
  const customerKeyword = removeAccents(customerListSearch.trim());
  const customerPhoneKeyword = customerListSearch.trim().replace(/[\s.]/g, '');
  const visibleCustomers = customerKeyword
    ? sortedCustomers.filter(
        (c) =>
          removeAccents(c.name).includes(customerKeyword) ||
          removeAccents(c.code).includes(customerKeyword) ||
          (customerPhoneKeyword && String(c.phone || '').replace(/[\s.]/g, '').includes(customerPhoneKeyword))
      )
    : sortedCustomers;

    // Khoảng ngày theo bộ lọc khách hàng (null = tất cả thời gian)
  const cusRange = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    if (cusPeriod === 'month' && cusMonth) {
      const [y, m] = cusMonth.split('-');
      return [`${y}-${m}-01`, `${y}-${m}-${pad(new Date(Number(y), Number(m), 0).getDate())}`];
    }
    if (cusPeriod === 'quarter' && cusYear) {
      const sm = (Number(cusQuarter) - 1) * 3 + 1;
      const em = sm + 2;
      return [`${cusYear}-${pad(sm)}-01`, `${cusYear}-${pad(em)}-${pad(new Date(Number(cusYear), em, 0).getDate())}`];
    }
    if (cusPeriod === 'year' && cusYear) return [`${cusYear}-01-01`, `${cusYear}-12-31`];
    if (cusPeriod === 'custom') return [cusFrom || '0000-00-00', cusTo || '9999-12-31'];
    return null;
  })();
  const cusStart = cusRange ? cusRange[0] : '';
  const cusEnd = cusRange ? cusRange[1] : '';

  // Tổng mua / đã thanh toán / nợ của từng khách trong khoảng đã lọc (tính từ phiếu bán + tạm ứng đơn đặt hàng chưa xuất)
  const customerStats = useMemo(() => {
    const map = {};
    const slot = (name) => map[name] || (map[name] = { total: 0, paid: 0, debt: 0 });
    (invoicesList || []).forEach((inv) => {
      const d = String(inv.created_at || '').slice(0, 10);
      if (cusStart && (d < cusStart || d > cusEnd)) return;
      const total = Number(inv.total) || 0;
      const paid = Number(inv.paid_amount) || 0;
      const debt = inv.debt !== undefined && inv.debt !== null ? Number(inv.debt) : total - paid;
      const m = slot(inv.customer_name);
      m.total += total; m.paid += paid; m.debt += debt;
    });
    (ordersList || []).forEach((o) => {
      if (!isPendingOrder(o)) return;
      const d = String(o.created_at || '').slice(0, 10);
      if (cusStart && (d < cusStart || d > cusEnd)) return;
      const paid = Number(o.paid_amount) || 0;
      if (paid > 0) slot(o.customer_name).paid += paid;
    });
    return map;
  }, [invoicesList, ordersList, cusStart, cusEnd]);

  // Dòng hiển thị: không lọc thời gian thì dùng số của server, có lọc thì dùng số tính theo kỳ
  const customerRows = visibleCustomers
    .filter((c) => !cusRange || customerStats[c.name])
    .map((c) => {
      if (!cusRange) return { ...c, f_total: Number(c.total_purchased) || 0, f_paid: customerPaidOf(c), f_debt: Number(c.total_debt) || 0 };
      const st = customerStats[c.name];
      return { ...c, f_total: st.total, f_paid: st.paid, f_debt: st.debt };
    });
  const customerSums = customerRows.reduce(
    (a, c) => ({ total: a.total + c.f_total, paid: a.paid + c.f_paid, debt: a.debt + c.f_debt }),
    { total: 0, paid: 0, debt: 0 }
  );

  // Mở popup xem / sửa từ trong popup khách hàng -> đóng popup khách hàng, đóng popup con là ra thẳng màn hình chính
  const customerChildOpen = !!(showDetailModal || showOrderModal || showCashModal || selectedCashItem);
  useEffect(() => {
    if (customerChildOpen) setShowCustomerDetailModal(false);
  }, [customerChildOpen]);

    // Đơn đặt hàng chưa xuất bán (để tính tạm ứng, tránh cộng trùng khi đã chuyển thành phiếu bán)
    function isPendingOrder(o) { return !o.status || /pending|chờ|đang/i.test(String(o.status)); }
  // Tổng đã thanh toán của khách = số server tính (phiếu bán) + tạm ứng các đơn đặt hàng chưa xuất bán
    function customerPaidOf(c) {
    return (Number(c.total_paid) || 0) +
      (ordersList || [])
        .filter((o) => o.customer_name === c.name && isPendingOrder(o))
        .reduce((s, o) => s + (Number(o.paid_amount) || 0), 0);
  }
  // Phiếu bán + đơn đặt hàng của khách đang xem (cho tab Đơn hàng)
  const getCustomerOrderRows = () => {
    const cus = selectedCustomerDetail;
    if (!cus) return [];
    const invs = customerDetailData.invoices || [];
    const ords = (ordersList || []).filter((o) => o.customer_name === cus.name);
    return [...invs, ...ords].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  };

  useEffect(() => { if (!showOrderModal) setDepositFromOrder(0); }, [showOrderModal]);

    // ----- Phiếu bảo hành -----
  useEffect(() => {
    try { localStorage.setItem('warranties', JSON.stringify(warranties)); } catch (e) { /* bỏ qua */ }
  }, [warranties]);

  const openWarrantyModal = (draft) => {
    setEditingWarrantyId(null);
    setWarrantyForm({
      code: newWarrantyCode(warranties),
      invoice_code: '', customer_name: '', customer_phone: '', address: '',
      purchase_date: todayLocal(), duration: 12, unit: 'month', note: '', items: [],
      ...(draft || {}),
    });
    setShowWarrantyModal(true);
  };

  // Chọn phiếu bán -> tự nạp khách hàng, ngày mua và sản phẩm
  const handleSelectWarrantyInvoice = async (code) => {
    const inv = (invoicesList || []).find((i) => i.code === code);
    if (!inv) { setWarrantyForm((f) => ({ ...f, invoice_code: code })); return; }
    try {
      const d = await api(`/api/invoices/${inv.id}`);
      setWarrantyForm((f) => ({
        ...f,
        invoice_code: inv.code,
        customer_name: d.customer_name || '',
        customer_phone: d.customer_phone || '',
        address: d.address || '',
        purchase_date: d.created_at ? String(d.created_at).slice(0, 10) : f.purchase_date,
        items: (d.items || []).map((it) => ({
          product_id: it.product_id, sku: it.sku || '', name: it.product_name || it.name || '',
          quantity: Number(it.quantity) || 1, detail: it.chassis_color || '',
        })),
      }));
    } catch (e) {
      alert('Lỗi tải phiếu bán: ' + e.message);
    }
  };

  const saveWarranty = () => {
    const f = warrantyForm;
    if (!f) return;
    if (!String(f.code || '').trim()) return alert('Vui lòng nhập mã phiếu bảo hành!');
    if (warranties.some((w) => w.code === f.code.trim() && w.id !== editingWarrantyId)) return alert('Mã phiếu bảo hành này đã tồn tại!');
    if (f.invoice_code && warranties.some((w) => w.invoice_code === f.invoice_code && w.id !== editingWarrantyId)) return alert(`Phiếu bán hàng ${f.invoice_code} đã có phiếu bảo hành, không thể tạo thêm!`);
    if (!String(f.customer_name || '').trim()) return alert('Vui lòng nhập tên khách hàng!');
    if (!f.items || f.items.length === 0) return alert('Phiếu bảo hành cần ít nhất 1 sản phẩm!');
    if (!(Number(f.duration) > 0)) return alert('Vui lòng nhập thời gian bảo hành!');
    const rec = {
      ...f,
      code: f.code.trim(),
      duration: Number(f.duration),
      expiry_date: addWarrantyDuration(f.purchase_date, f.duration, f.unit),
    };
    if (editingWarrantyId) {
      setWarranties((list) => list.map((w) => (w.id === editingWarrantyId ? { ...w, ...rec } : w)));
      setMsg({ type: 'ok', text: `Đã cập nhật phiếu bảo hành ${rec.code}` });
    } else {
      setWarranties((list) => [{ ...rec, id: 'w' + Date.now(), created_at: nowLocalISO() }, ...list]);
      setMsg({ type: 'ok', text: `Đã tạo phiếu bảo hành ${rec.code}` });
    }
    setShowWarrantyModal(false);
    setEditingWarrantyId(null);
  };

  const editWarranty = (w) => {
    setEditingWarrantyId(w.id);
    setWarrantyForm({ ...w, items: (w.items || []).map((x) => ({ ...x })) });
    setShowWarrantyModal(true);
  };

  const deleteWarranty = (w) => {
    if (!confirm(`Xóa phiếu bảo hành ${w.code}?`)) return;
    setWarranties((list) => list.filter((x) => x.id !== w.id));
    setMsg({ type: 'ok', text: `Đã xóa phiếu bảo hành ${w.code}` });
  };

  const wKeyword = removeAccents(warrantySearch.trim());
  const visibleWarranties = sortDesc(warranties).filter((w) => {
    if (warrantyFilter !== 'all' && warrantyStatus(w.expiry_date).key !== warrantyFilter) return false;
    if (!wKeyword) return true;
    const hay = removeAccents([
      w.code, w.invoice_code, w.customer_name, w.customer_phone, w.address,
      ...(w.items || []).map((i) => `${i.name} ${i.sku} ${i.detail || ''}`),
    ].join(' '));
    return hay.includes(wKeyword);
  });

    // ----- Màn hình Nhập hàng: tìm kiếm + lọc thời gian + KPI -----
  const purRange = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    if (purPeriod === 'month' && purMonth) {
      const [y, m] = purMonth.split('-');
      return [`${y}-${m}-01`, `${y}-${m}-${pad(new Date(Number(y), Number(m), 0).getDate())}`];
    }
    if (purPeriod === 'quarter' && purYear) {
      const sm = (Number(purQuarter) - 1) * 3 + 1;
      const em = sm + 2;
      return [`${purYear}-${pad(sm)}-01`, `${purYear}-${pad(em)}-${pad(new Date(Number(purYear), em, 0).getDate())}`];
    }
    if (purPeriod === 'year' && purYear) return [`${purYear}-01-01`, `${purYear}-12-31`];
    if (purPeriod === 'custom') return [purFrom || '0000-00-00', purTo || '9999-12-31'];
    return null;
  })();

  const purKeyword = removeAccents(purSearch.trim());
  const purPhoneKeyword = purSearch.trim().replace(/[\s.]/g, '');
  const visiblePurchases = (purchaseOrders || []).filter((po) => {
    if (purRange) {
      const d = String(po.created_at || '').slice(0, 10);
      if (d < purRange[0] || d > purRange[1]) return false;
    }
    if (!purKeyword) return true;
    const sup = (suppliers || []).find((s) => String(s.id) === String(po.supplier_id));
    return (
      removeAccents(po.supplier_name || (sup && sup.name)).includes(purKeyword) ||
      removeAccents(sup && sup.code).includes(purKeyword) ||
      removeAccents(po.code).includes(purKeyword) ||
      (purPhoneKeyword && String((sup && sup.phone) || '').replace(/[\s.]/g, '').includes(purPhoneKeyword))
    );
  });
  const purFiltering = !!(purRange || purKeyword);
  const purSums = visiblePurchases.reduce((a, po) => {
    const total = Number(po.total) || 0;
    const paid = Number(po.paid_amount) || 0;
    const debt = po.debt !== undefined && po.debt !== null ? Number(po.debt) : total - paid;
    return { total: a.total + total, paid: a.paid + paid, debt: a.debt + debt };
  }, { total: 0, paid: 0, debt: 0 });
  
  const filteredPosProducts = (products || []).filter((p) =>
    p.name.toLowerCase().includes(posProductKeyword.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(posProductKeyword.toLowerCase()))
  );

  const filteredPosCustomers = (customers || []).filter((c) =>
    c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
    (c.phone && c.phone.includes(customerSearch)) ||
    (c.code || '').toLowerCase().includes(customerSearch.toLowerCase())
  );

  // ----- Màn hình Tạo đơn hàng: lọc theo thời gian + từ khóa, tính KPI -----
const posRange = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  if (posPeriod === 'month' && posMonth) {
    const [y, m] = posMonth.split('-');
    return [`${y}-${m}-01`, `${y}-${m}-${pad(new Date(Number(y), Number(m), 0).getDate())}`];
  }
  if (posPeriod === 'quarter' && posYear) {
    const sm = (Number(posQuarter) - 1) * 3 + 1;
    const em = sm + 2;
    return [`${posYear}-${pad(sm)}-01`, `${posYear}-${pad(em)}-${pad(new Date(Number(posYear), em, 0).getDate())}`];
  }
  if (posPeriod === 'year' && posYear) return [`${posYear}-01-01`, `${posYear}-12-31`];
  if (posPeriod === 'custom') return [posFrom || '0000-00-00', posTo || '9999-12-31'];
  return null;
})();

const posKeyword = removeAccents(posSearch.trim());
const posPhoneKeyword = posSearch.trim().replace(/[\s.]/g, '');

// Dùng chung cho cả phiếu bán hàng và đơn đặt hàng: khớp tên KH, mã KH, SĐT, mã phiếu/đơn
const matchPosDoc = (doc) => {
  if (posRange) {
    const d = String(doc.created_at || '').slice(0, 10);
    if (d < posRange[0] || d > posRange[1]) return false;
  }
  if (!posKeyword) return true;
  const cus = (customers || []).find((c) => c.name === doc.customer_name);
  return (
    removeAccents(doc.code).includes(posKeyword) ||
    removeAccents(doc.customer_name).includes(posKeyword) ||
    removeAccents(cus && cus.code).includes(posKeyword) ||
    (posPhoneKeyword && String(doc.customer_phone || (cus && cus.phone) || '').replace(/[\s.]/g, '').includes(posPhoneKeyword))
  );
};

const visibleInvoices = (invoicesList || []).filter(matchPosDoc);
const visibleOrders = (ordersList || []).filter(matchPosDoc);
const posFiltering = !!(posRange || posKeyword);
const posSums = {
  invoiceTotal: visibleInvoices.reduce((s, i) => s + (Number(i.total) || 0), 0),
  orderTotal: visibleOrders.reduce((s, o) => s + (Number(o.total) || 0), 0),
};
  
  // Chuyển màn hình từ menu trái (gộp các lệnh tải dữ liệu riêng của từng mục)
const goView = (view) => {
  setCurrentView(view);
  if (view === 'return-orders') loadReturnOrders();
  if (view === 'purchase-returns') loadPurchaseReturns();
  if (view === 'profit-loss-report') loadProfitLossReport();
  // 'cash-book' và 'inventory-report' đã tự tải qua useEffect theo currentView
};

  // Mã các phiếu bán hàng đã có phiếu bảo hành (để làm mờ nút tạo bảo hành)
  const warrantiedInvoices = new Set((warranties || []).map((w) => w.invoice_code).filter(Boolean));
  
  return (
        <div className="layout" style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>
      <style>{RESPONSIVE_CSS}</style>

      {/* Thanh trên cùng (chỉ hiện trên điện thoại) */}
      <div className="mobile-topbar">
        <button onClick={() => setSidebarOpen(true)} aria-label="Mở menu">☰</button>
        <span>LK Ebike POS</span>
      </div>

      {/* Nền mờ bấm vào để đóng menu (chỉ hiện trên điện thoại) */}
      <div className={`sidebar-backdrop ${sidebarOpen ? 'show' : ''}`} onClick={() => setSidebarOpen(false)} />

      {/* Thanh menu bên trái */}
<aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} style={{ width: '260px', background: '#1e293b', color: '#fff', padding: '20px' }}>
  <h2 style={{ fontSize: '1.2rem', marginBottom: '20px', color: '#38bdf8' }}>LK Ebike POS</h2>

  <nav onClick={(e) => { if (e.target.closest('button')) setSidebarOpen(false); }} /* chọn mục xong tự ẩn menu trên điện thoại */>
    {MENU_GROUPS.map((group, gi) => (
      <div key={group.title}>
        {gi > 0 && <hr style={menuDividerStyle} />}
        <div style={menuGroupTitleStyle}>{group.title}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {group.items.map((it) => (
            <button
              key={it.view}
              onClick={() => goView(it.view)}
              style={menuBtnStyle(currentView === it.view)}
            >
              {it.label}
            </button>
          ))}
        </div>
      </div>
    ))}
  </nav>
</aside>

      {/* Nội dung chính bên phải */}
      <main className="main-content" style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {msg && <div style={{ padding: '10px', marginBottom: '15px', borderRadius: '6px', background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#166534' : '#991b1b' }}>{msg.text}</div>}

        {/* 1. MÀN HÌNH DANH SÁCH ĐƠN HÀNG & PHIẾU BÁN HÀNG */}
        {currentView === 'pos' && (
            <div className="pos-page">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Đơn hàng & Phiếu bán hàng</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => { setEditingOrderId(null); setEditingInvoiceId(null); setEditingInvoiceOriginalQty({}); setModalOrderType('invoices'); setCart({}); setPosCustomer({ name: '', phone: '', address: '' }); setCustomerSearch(''); setPaidAmount(0); setShowOrderModal(true); }}
                  style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Tạo Phiếu Bán Hàng
                </button>
                <button
                  onClick={() => { setEditingOrderId(null); setEditingInvoiceId(null); setEditingInvoiceOriginalQty({}); setModalOrderType('orders'); setCart({}); setPosCustomer({ name: '', phone: '', address: '' }); setCustomerSearch(''); setPaidAmount(0); setShowOrderModal(true); }}
                  style={{ padding: '10px 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Tạo Đơn Đặt Hàng
                </button>
              </div>
            </div>

            {/* Tìm kiếm + lọc thời gian + KPI */}
<div style={{ flexShrink: 0 }}>
  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
    <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: '460px' }}>
      <input
        placeholder="🔍 Tìm theo tên KH, mã KH, SĐT hoặc mã phiếu..."
        value={posSearch}
        onChange={(e) => setPosSearch(e.target.value)}
        style={{ ...inputStyle, margin: 0, paddingRight: posSearch ? '36px' : '10px' }}
      />
      {posSearch && (
        <button
          type="button"
          onClick={() => setPosSearch('')}
          title="Xóa tìm kiếm"
          style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}
        >✕</button>
      )}
    </div>

    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#475569' }}>Lọc theo:</span>
      <select value={posPeriod} onChange={(e) => setPosPeriod(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
        <option value="all">Tất cả thời gian</option>
        <option value="month">Theo tháng</option>
        <option value="quarter">Theo quý</option>
        <option value="year">Theo năm</option>
        <option value="custom">Khoảng ngày</option>
      </select>

      {posPeriod === 'month' && (
        <input type="month" value={posMonth} onChange={(e) => setPosMonth(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
      )}
      {posPeriod === 'quarter' && (
        <>
          <select value={posQuarter} onChange={(e) => setPosQuarter(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
            <option value="1">Quý 1</option>
            <option value="2">Quý 2</option>
            <option value="3">Quý 3</option>
            <option value="4">Quý 4</option>
          </select>
          <input type="number" value={posYear} onChange={(e) => setPosYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
        </>
      )}
      {posPeriod === 'year' && (
        <input type="number" value={posYear} onChange={(e) => setPosYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
      )}
      {posPeriod === 'custom' && (
        <>
          <input type="date" value={posFrom} onChange={(e) => setPosFrom(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
          <span>đến</span>
          <input type="date" value={posTo} onChange={(e) => setPosTo(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
        </>
      )}
      {posPeriod !== 'all' && (
        <button type="button" onClick={() => setPosPeriod('all')} style={{ padding: '7px 12px', background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xóa lọc</button>
      )}
    </div>
  </div>

  {/* 4 ô KPI */}
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #16a34a' }}>
      <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG GIÁ TRỊ BÁN</div>
      <div style={{ fontSize: '18px', fontWeight: '900', color: '#16a34a', marginTop: '4px' }}>{vnd(posSums.invoiceTotal)}</div>
    </div>
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #7c3aed' }}>
      <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG GIÁ TRỊ ĐẶT HÀNG</div>
      <div style={{ fontSize: '18px', fontWeight: '900', color: '#7c3aed', marginTop: '4px' }}>{vnd(posSums.orderTotal)}</div>
    </div>
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #0284c7' }}>
      <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG PHIẾU BÁN</div>
      <div style={{ fontSize: '18px', fontWeight: '900', color: '#0284c7', marginTop: '4px' }}>{visibleInvoices.length}</div>
    </div>
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #d97706' }}>
      <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG ĐƠN ĐẶT HÀNG</div>
      <div style={{ fontSize: '18px', fontWeight: '900', color: '#d97706', marginTop: '4px' }}>{visibleOrders.length}</div>
    </div>
  </div>
</div>

            {/* Bảng Danh sách Phiếu Bán Hàng */}
           <div className="pos-card" style={{ background: '#fff', padding: '20px', borderRadius: '8px', marginBottom: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, color: '#16a34a' }}>📦 Danh sách Phiếu Bán Hàng ({visibleInvoices.length}{posFiltering ? `/${invoicesList.length}` : ''})</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                    <th style={{ padding: '10px' }}>Mã phiếu</th>
                    <th style={{ padding: '10px' }}>Ngày bán</th>
                    <th style={{ padding: '10px' }}>Khách hàng</th>
                    <th style={{ padding: '10px' }}>Tổng tiền</th>
                    <th style={{ padding: '10px' }}>Đã thanh toán</th>
                    <th style={{ padding: '10px' }}>Còn nợ</th>
                    <th style={{ padding: '10px' }}>Thanh toán</th>
                    <th style={{ padding: '10px', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInvoices.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '15px', color: '#94a3b8' }}>{posFiltering ? 'Không tìm thấy phiếu bán hàng phù hợp.' : 'Chưa có phiếu bán hàng nào.'}</td></tr>
                  ) : (
                    visibleInvoices.map((inv) => (
                      <tr key={inv.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '10px', fontWeight: 'bold', color: '#0284c7' }}>{inv.code}</td>
                        <td style={{ padding: '10px' }}>{inv.created_at ? new Date(inv.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                        <td style={{ padding: '10px', fontWeight: '500' }}>{inv.customer_name}</td>
                        <td style={{ padding: '10px', fontWeight: 'bold' }}>{vnd(inv.total)}</td>
                        <td style={{ padding: '10px', color: '#16a34a' }}>{vnd(inv.paid_amount)}</td>
                        <td style={{ padding: '10px', color: inv.debt > 0 ? '#dc2626' : '#16a34a' }}>{vnd(inv.debt)}</td>
                        <td style={{ padding: '10px' }}>{inv.payment_method || 'Tiền mặt'}</td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                         {(() => {
                          const hasWarranty = warrantiedInvoices.has(inv.code);
                          return (
                            <button
                              disabled={hasWarranty}
                              onClick={() => { openWarrantyModal({ invoice_code: inv.code }); handleSelectWarrantyInvoice(inv.code); }}
                              title={hasWarranty ? 'Phiếu bán hàng này đã có phiếu bảo hành' : 'Tạo phiếu bảo hành'}
                              style={{
                                background: '#dcfce7', color: '#16a34a', border: 'none', padding: '4px 6px', borderRadius: '4px', marginRight: '4px',
                                cursor: hasWarranty ? 'not-allowed' : 'pointer',
                                opacity: hasWarranty ? 0.35 : 1,
                                filter: hasWarranty ? 'grayscale(1)' : 'none',
                              }}
                            >🛡️</button>
                          );
                        })()}
                          <button onClick={() => handlePrintOrder(inv, false)} title="In phiếu bán hàng" style={{ background: '#e0f2fe', color: '#0284c7', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>🖨️</button>
                          <button onClick={() => handleViewDetail('invoices', inv.id)} title="Xem chi tiết" style={{ background: '#f1f5f9', color: '#475569', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>👁️</button>
                          <button onClick={() => handleEditInvoice(inv)} title="Sửa" style={{ background: '#fef3c7', color: '#d97706', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>✏️</button>
                          <button onClick={() => handleDeleteOrderOrInvoice('invoices', inv.id, inv.code)} title="Xóa" style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer' }}>🗑️</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Bảng Danh sách Đơn Đặt Hàng */}
            <div className="pos-card" style={{ background: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, color: '#7c3aed' }}>📝 Danh sách Đơn Đặt Hàng ({visibleOrders.length}{posFiltering ? /${ordersList.length} : ''})</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                    <th style={{ padding: '10px' }}>Mã đơn</th>
                    <th style={{ padding: '10px' }}>Ngày đặt</th>
                    <th style={{ padding: '10px' }}>Khách hàng</th>
                    <th style={{ padding: '10px' }}>Tổng tiền</th>
                    <th style={{ padding: '10px' }}>Đã tạm ứng</th>
                    <th style={{ padding: '10px' }}>Còn nợ</th>
                    <th style={{ padding: '10px' }}>Trạng thái</th>
                    <th style={{ padding: '10px', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '15px', color: '#94a3b8' }}>{posFiltering ? 'Không tìm thấy đơn đặt hàng phù hợp.' : 'Chưa có đơn đặt hàng nào.'}</td></tr>
                  ) : (
                    visibleOrders.map(ord => (
                      <tr key={ord.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '10px', fontWeight: 'bold', color: '#7c3aed' }}>{ord.code}</td>
                        <td style={{ padding: '10px' }}>{ord.created_at ? new Date(ord.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                        <td style={{ padding: '10px', fontWeight: '500' }}>{ord.customer_name}</td>
                        <td style={{ padding: '10px', fontWeight: 'bold' }}>{vnd(ord.total)}</td>
                        <td style={{ padding: '10px', color: '#16a34a' }}>{vnd(ord.paid_amount)}</td>
                        <td style={{ padding: '10px', color: '#dc2626' }}>{vnd(ord.debt)}</td>
                        <td style={{ padding: '10px' }}><span style={{ padding: '3px 8px', borderRadius: '4px', background: '#fef3c7', color: '#d97706', fontSize: '12px', fontWeight: 'bold' }}>{ord.status || 'Pending'}</span></td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <button onClick={() => handleViewDetail('orders', ord.id)} title="Xem chi tiết" style={{ background: '#e0f2fe', color: '#0284c7', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>👁️</button>
                          <button onClick={() => handlePrintOrder(ord, true)} title="In đơn đặt hàng" style={{ background: '#e0f2fe', color: '#0284c7', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>🖨️</button>
                          <button onClick={() => handleEditOrder(ord)} title="Sửa" style={{ background: '#fef3c7', color: '#d97706', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>✏️</button>
                          <button onClick={() => handleDeleteOrderOrInvoice('orders', ord.id, ord.code)} title="Xóa" style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer' }}>🗑️</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showDetailModal && detailData && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <div style={{ background: '#fff', width: '700px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#7c3aed' }}>Chi tiết: {detailData.code}</h3>
                <button onClick={() => setShowDetailModal(false)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
              </div>

              <div style={{ marginBottom: '15px', background: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
                <div><b>Khách hàng:</b> {detailData.customer_name} ({detailData.customer_phone || 'Chưa có SĐT'})</div>
                <div><b>Địa chỉ:</b> {detailData.address || '---'}</div>
                <div><b>Ngày tạo:</b> {detailData.created_at ? new Date(detailData.created_at).toLocaleDateString('vi-VN') : '---'}</div>
              </div>

              <div style={{ flex: 1, maxHeight: '250px', overflowY: 'auto', marginBottom: '15px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                      <th style={{ padding: '8px' }}>Sản phẩm</th>
                      <th style={{ padding: '8px' }}>SL</th>
                      <th style={{ padding: '8px' }}>Đơn giá</th>
                      <th style={{ padding: '8px' }}>Giảm</th>
                      <th style={{ padding: '8px' }}>Thành tiền</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailData.items || []).map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '8px' }}>
                          <div>{item.product_name}</div>
                          {item.chassis_color && <div style={{ fontSize: '11px', color: '#7c3aed', fontStyle: 'italic' }}>{item.chassis_color}</div>}
                        </td>
                        <td style={{ padding: '8px' }}>{item.quantity}</td>
                        <td style={{ padding: '8px' }}>{vnd(item.price)}</td>
                        <td style={{ padding: '8px' }}>{vnd(item.discount)}</td>
                        <td style={{ padding: '8px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(item.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '20px' }}>
                <span>Tổng tiền:</span> <span style={{ color: '#7c3aed' }}>{vnd(detailData.total)}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
                <button
                  onClick={() => handlePrintOrder(detailData, (detailData.code || '').startsWith('DH'))}
                  style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  🖨️ In Chứng Từ
                </button>
                <button onClick={() => setShowDetailModal(false)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
              </div>

            </div>
          </div>
        )}

        {/* MÀN HÌNH QUẢN LÝ TRẢ HÀNG */}
        {currentView === 'return-orders' && (
          <div style={{ flex: 1, padding: '24px', background: '#f8fafc', minHeight: '100vh', overflowY: 'auto', boxSizing: 'border-box' }}>

            {/* Header & Nút Tạo Phiếu */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#1e293b', fontSize: '24px' }}>Quản Lý Trả Hàng</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={loadReturnOrders} style={{ background: '#fff', border: '1px solid #cbd5e1', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  🔄 Làm mới
                </button>
                <button
                  onClick={openCreateReturn}
                  style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Tạo Phiếu Trả Hàng
                </button>
              </div>
            </div>

            {/* Các thẻ Thống kê tổng quan */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '25px' }}>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Tổng phiếu trả</div>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0f172a' }}>{returnOrdersData.stats.total}</div>
              </div>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Đang chờ xử lý</div>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#d97706' }}>{returnOrdersData.stats.pending}</div>
              </div>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Đã hoàn thành</div>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#16a34a' }}>{returnOrdersData.stats.completed}</div>
              </div>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Tổng tiền hoàn</div>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#7c3aed' }}>{vnd(returnOrdersData.stats.totalRefund)}</div>
              </div>
            </div>

            {/* Bảng Danh Sách Phiếu Trả Hàng */}
            <div style={{ background: '#fff', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', textAlign: 'left' }}>
                    <th style={{ padding: '14px' }}>MÃ PHIẾU</th>
                    <th style={{ padding: '14px' }}>MÃ ĐƠN GỐC</th>
                    <th style={{ padding: '14px' }}>KHÁCH HÀNG</th>
                    <th style={{ padding: '14px' }}>NGÀY TRẢ</th>
                    <th style={{ padding: '14px', textAlign: 'right' }}>TỔNG TIỀN</th>
                    <th style={{ padding: '14px', textAlign: 'right' }}>TIỀN HOÀN</th>
                    <th style={{ padding: '14px' }}>LÝ DO</th>
                    <th style={{ padding: '14px' }}>TRẠNG THÁI</th>
                    <th style={{ padding: '14px', textAlign: 'center' }}>THAO TÁC</th>
                  </tr>
                </thead>
                <tbody>
                  {returnOrdersData.list.length === 0 ? (
                    <tr>
                      <td colSpan="9" style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>Chưa có phiếu trả hàng nào.</td>
                    </tr>
                  ) : (
                    returnOrdersData.list.map((item, index) => (
                      <tr key={item.id ?? index} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '14px', fontWeight: 'bold', color: '#0284c7' }}>{item.code}</td>
                        <td style={{ padding: '14px', color: '#475569' }}>{item.invoice_code || '-'}</td>
                        <td style={{ padding: '14px', fontWeight: '500' }}>{item.customer_name}</td>
                        <td style={{ padding: '14px' }}>{item.return_date ? item.return_date.slice(0, 10) : ''}</td>
                        <td style={{ padding: '14px', textAlign: 'right', fontWeight: 'bold', color: '#dc2626' }}>{vnd(item.refund_amount)}</td>
                        <td style={{ padding: '14px', textAlign: 'right', fontWeight: 'bold', color: '#16a34a' }}>{vnd(item.refund_amount)}</td>
                        <td style={{ padding: '14px' }}>{item.reason}</td>
                        <td style={{ padding: '14px' }}>
                          <span style={{ padding: '4px 10px', borderRadius: '20px', background: isDoneReturn(item.status) ? '#dcfce7' : '#fef3c7', color: isDoneReturn(item.status) ? '#16a34a' : '#d97706', fontWeight: '500', fontSize: '12px' }}>
                            {item.status}
                          </span>
                        </td>
                        <td style={{ padding: '14px', textAlign: 'center' }}>
                          <button title="Xem" onClick={() => handleViewReturn(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', marginRight: '8px' }}>👁️</button>
                          <button title="Sửa" onClick={() => handleEditReturn(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', marginRight: '8px' }}>✏️</button>
                          <button title="Xóa" onClick={() => handleDeleteReturn(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px' }}>🗑️</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* POPUP XEM CHI TIẾT PHIẾU TRẢ HÀNG BÁN */}
            {returnDetail && (
              <div style={overlayStyle}>
                <div style={{ background: '#fff', width: '700px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', overflowY: 'auto' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#7c3aed' }}>Chi tiết: {returnDetail.code}</h3>
                    <button onClick={() => setReturnDetail(null)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
                  </div>
                  <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '8px', marginBottom: '15px' }}>
                    <div><b>Khách hàng:</b> {returnDetail.customer_name}</div>
                    <div><b>Phiếu bán gốc:</b> {returnDetail.invoice_code || '---'}</div>
                    <div><b>Ngày trả:</b> {returnDetail.return_date ? String(returnDetail.return_date).slice(0, 10) : '---'}</div>
                    <div><b>Lý do:</b> {returnDetail.reason} &nbsp;|&nbsp; <b>Trạng thái:</b> {returnDetail.status}</div>
                    <div><b>Phương thức hoàn tiền:</b> {returnDetail.payment_method || 'Tiền mặt'}</div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '15px' }}>
                    <thead>
                      <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                        <th style={{ padding: '8px' }}>Sản phẩm</th><th style={{ padding: '8px' }}>SL</th><th style={{ padding: '8px' }}>Đơn giá</th><th style={{ padding: '8px' }}>Thành tiền</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(returnDetail.items || []).length === 0 ? (
                        <tr><td colSpan="4" style={{ textAlign: 'center', padding: '15px', color: '#94a3b8' }}>Phiếu này chưa có chi tiết sản phẩm.</td></tr>
                      ) : (returnDetail.items || []).map((it, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '8px' }}>{it.sku ? `${it.sku} - ` : ''}{it.product_name}</td>
                          <td style={{ padding: '8px' }}>{it.quantity}</td>
                          <td style={{ padding: '8px' }}>{vnd(it.price)}</td>
                          <td style={{ padding: '8px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(it.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
                    <span>Tiền hoàn trả khách:</span><span style={{ color: '#dc2626' }}>{vnd(returnDetail.refund_amount)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                    <button onClick={() => setReturnDetail(null)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
                  </div>
                </div>
              </div>
            )}

            {/* POPUP TẠO / SỬA PHIẾU TRẢ HÀNG */}
            {showReturnModal && (
              <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                <div style={{ background: '#fff', width: '950px', maxHeight: '90vh', borderRadius: '12px', padding: '24px', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 25px rgba(0,0,0,0.2)', overflowY: 'auto', boxSizing: 'border-box' }}>

                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px', marginBottom: '20px' }}>
                    <h3 style={{ margin: 0, color: '#1e293b' }}>{editingReturnId ? '✏️ Sửa Phiếu Trả Hàng (Khách Trả Lại)' : 'Tạo Phiếu Trả Hàng (Khách Trả Lại)'}</h3>
                    <button onClick={closeReturnModal} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
                  </div>

                  {/* Hàng 1: Khách hàng, Chọn phiếu bán gốc, Ngày trả */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', marginBottom: '15px' }}>

                    {/* Trường Khách Hàng */}
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Khách hàng:</label>
                      <div style={{ position: 'relative' }}>
                        <input
                          placeholder="Gõ tên, SĐT hoặc mã khách hàng..."
                          value={returnCustomerSearch}
                          onChange={(e) => {
                            const v = e.target.value;
                            setReturnCustomerSearch(v);
                            setReturnForm((f) => ({ ...f, customer_name: v, invoice_code: '' }));
                            setShowReturnCustomerDropdown(true);
                          }}
                          onFocus={() => setShowReturnCustomerDropdown(true)}
                          onBlur={() => setTimeout(() => setShowReturnCustomerDropdown(false), 150)}
                          style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
                        />
                        {showReturnCustomerDropdown && (() => {
                          const q = returnCustomerSearch.trim().toLowerCase();
                          const list = (customers || []).filter((c) =>
                            !q ||
                            (c.name || '').toLowerCase().includes(q) ||
                            (c.phone && c.phone.includes(q)) ||
                            (c.code || '').toLowerCase().includes(q)
                          ).slice(0, 50);
                          if (list.length === 0) return null;
                          return (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '200px', overflowY: 'auto', zIndex: 20, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                              {list.map((c) => (
                                <div
                                  key={c.id}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    const changed = c.name !== returnForm.customer_name;
                                    setReturnCustomerSearch(c.name);
                                    setReturnForm((f) => ({ ...f, customer_name: c.name, invoice_code: changed ? '' : f.invoice_code }));
                                    if (changed && returnForm.invoice_code) setReturnItems([]); // đổi khách thì bỏ hàng của phiếu cũ
                                    setShowReturnCustomerDropdown(false);
                                  }}
                                  style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                                >
                                  <b>{c.name}</b> - <span style={{ color: '#64748b' }}>{c.phone || 'Chưa có SĐT'} ({c.code})</span>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Trường Chọn Phiếu Bán Gốc (Tự động lọc theo khách hàng đã chọn) */}
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Chọn phiếu bán gốc:</label>
                      <select
                        value={returnForm.invoice_code}
                        onChange={e => handleSelectReturnInvoice(e.target.value)}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box', background: '#fff' }}
                      >
                        <option value="">-- Chọn Phiếu Bán Gốc --</option>
                        {/* SỬA: trước đây dùng biến `invoices` không tồn tại, đúng phải là `invoicesList` */}
                        {(invoicesList || [])
                          .filter(inv => !returnForm.customer_name.trim() || (inv.customer_name || '').toLowerCase().includes(returnForm.customer_name.trim().toLowerCase()))
                          .map((inv, idx) => (
                            <option key={idx} value={inv.code || inv.id}>
                              {inv.code || `BH-${inv.id}`} - {inv.customer_name || 'Khách lẻ'} ({inv.total ? vnd(inv.total) : ''})
                            </option>
                          ))}
                      </select>
                    </div>

                    {/* Ngày trả */}
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Ngày trả:</label>
                      <input
                        type="date"
                        value={returnForm.return_date}
                        onChange={e => setReturnForm({ ...returnForm, return_date: e.target.value })}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>

                  {/* Hàng 2: Lý do, Số tiền hoàn, Trạng thái */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Lý do trả:</label>
                      <select
                        value={returnForm.reason}
                        onChange={e => setReturnForm({ ...returnForm, reason: e.target.value })}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box', background: '#fff' }}
                      >
                        <option value="Sản phẩm lỗi">Sản phẩm lỗi</option>
                        <option value="Đổi ý">Đổi ý</option>
                        <option value="Lý do khác">Lý do khác</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Số tiền hoàn trả khách:</label>
                      <input
                        type="number"
                        placeholder="0"
                        value={returnForm.refund_amount}
                        onChange={e => setReturnForm({ ...returnForm, refund_amount: e.target.value })}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Trạng thái xử lý:</label>
                      <select
                        value={returnForm.status}
                        onChange={e => setReturnForm({ ...returnForm, status: e.target.value })}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box', background: '#fff' }}
                      >
                        <option value="Hoàn Thành (Cộng kho & trừ nợ)">Hoàn Thành (Cộng kho & trừ nợ)</option>
                        <option value="Đang xử lý">Đang xử lý</option>
                      </select>
                    </div>
                  </div>

                  {/* Hàng 3: Phương thức hoàn tiền (dùng để ghi phiếu chi vào Thu chi) */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '15px', marginBottom: '20px' }}>
                    <div>
                      <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: '500', color: '#475569' }}>Phương thức hoàn tiền:</label>
                      <select
                        value={returnForm.payment_method}
                        onChange={e => setReturnForm({ ...returnForm, payment_method: e.target.value })}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box', background: '#fff' }}
                      >
                        <option value="Tiền mặt">Tiền mặt</option>
                        <option value="Chuyển khoản">Chuyển khoản</option>
                      </select>
                    </div>
                    <div style={{ alignSelf: 'end', fontSize: '12px', color: '#64748b', paddingBottom: '10px' }}>
                      Số tiền hoàn trả khách &gt; 0 sẽ tự ghi một phiếu chi vào mục Thu chi.
                    </div>
                  </div>

                  {/* Ô tìm kiếm sản phẩm tự do (Dùng khi phiếu trả tự tạo không có phiếu bán gốc) */}
                  <div style={{ marginBottom: '15px' }}>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="text"
                        placeholder="🔍 Hoặc gõ mã/tên sản phẩm để thêm vào danh sách trả..."
                        value={returnProductKeyword}
                        onChange={(e) => setReturnProductKeyword(e.target.value)}
                        style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box', fontSize: '14px' }}
                      />
                      {returnProductKeyword.trim() && (() => {
                        const q = returnProductKeyword.trim().toLowerCase();
                        const list = (products || []).filter((p) =>
                          (p.name || '').toLowerCase().includes(q) || (p.sku && p.sku.toLowerCase().includes(q))
                        ).slice(0, 30);
                        return (
                          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '220px', overflowY: 'auto', zIndex: 20, marginTop: '4px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                            {list.length === 0 ? (
                              <div style={{ padding: '12px', color: '#94a3b8', textAlign: 'center' }}>Không tìm thấy sản phẩm nào.</div>
                            ) : list.map((p) => (
                              <div
                                key={p.id}
                                onClick={() => addReturnProduct(p)}
                                style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9' }}
                              >
                                <span><b>{p.sku ? `${p.sku} - ` : ''}{p.name}</b></span>
                                <span style={{ color: '#7c3aed', fontWeight: 'bold' }}>{vnd(p.price)} &nbsp;<span style={{ color: '#0284c7' }}>+ Thêm</span></span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Bảng chi tiết sản phẩm trả lại */}
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', marginBottom: '20px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                      <thead>
                        <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', textAlign: 'left' }}>
                          <th style={{ padding: '10px 14px' }}>Mã SP</th>
                          <th style={{ padding: '10px 14px' }}>Tên Sản Phẩm</th>
                          <th style={{ padding: '10px 14px', textAlign: 'center' }}>Số lượng</th>
                          <th style={{ padding: '10px 14px', textAlign: 'right' }}>Đơn giá</th>
                          <th style={{ padding: '10px 14px', textAlign: 'right' }}>Thành tiền</th>
                          <th style={{ padding: '10px 14px', textAlign: 'center', width: '50px' }}>Xóa</th>
                        </tr>
                      </thead>
                      <tbody>
                        {returnLoading ? (
                          <tr>
                            <td colSpan="6" style={{ textAlign: 'center', padding: '25px', color: '#94a3b8' }}>Đang tải sản phẩm của phiếu bán...</td>
                          </tr>
                        ) : (!returnForm.items || returnForm.items.length === 0) ? (
                          <tr>
                            <td colSpan="6" style={{ textAlign: 'center', padding: '25px', color: '#94a3b8' }}>
                              Chưa có sản phẩm trả lại
                            </td>
                          </tr>
                        ) : (
                          returnForm.items.map((it, idx) => (
                            <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '10px 14px' }}>{it.sku}</td>
                              <td style={{ padding: '10px 14px', fontWeight: '500' }}>{it.name}</td>
                              <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                <input
                                  type="number"
                                  min="0"
                                  max={it.max_qty || undefined}
                                  value={it.quantity}
                                  onChange={(e) => {
                                    let q = Math.max(0, Number(e.target.value) || 0);
                                    if (it.max_qty) q = Math.min(q, it.max_qty);
                                    updateReturnItem(idx, { quantity: q });
                                  }}
                                  style={{ width: '60px', padding: '6px', textAlign: 'center' }}
                                />
                                {it.max_qty ? <div style={{ fontSize: '11px', color: '#94a3b8' }}>tối đa {it.max_qty}</div> : null}
                              </td>

                              {/* Cột đơn giá cho phép nhập / sửa tùy chỉnh */}
                              <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                                <input
                                  type="number"
                                  min="0"
                                  value={it.price}
                                  onChange={(e) => {
                                    const newPrice = Number(e.target.value) || 0;
                                    updateReturnItem(idx, { price: newPrice });
                                  }}
                                  style={{ width: '120px', padding: '6px', textAlign: 'right', borderRadius: '4px', border: '1px solid #cbd5e1', fontWeight: 'bold' }}
                                />
                              </td>

                              <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 'bold', color: '#7c3aed' }}>
                                {vnd(it.quantity * it.price)}
                              </td>
                              <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                <button onClick={() => removeReturnItem(idx)} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Tổng giá trị và nút hành động */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px dashed #cbd5e1', paddingTop: '15px' }}>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#0f172a' }}>
                      Tổng giá trị hàng trả: <span style={{ color: '#7c3aed' }}>{vnd(calcReturnTotal(returnForm.items))}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        onClick={closeReturnModal}
                        style={{ background: '#e2e8f0', color: '#334155', border: 'none', padding: '10px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                      >
                        Hủy
                      </button>
                      <button
                        onClick={handleCreateReturnOrder}
                        style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '10px 25px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                      >
                        {editingReturnId ? 'Cập Nhật Phiếu Trả' : 'Tạo Phiếu Trả'}
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )}

          </div>
        )}

        {/* MÀN HÌNH TRẢ HÀNG NHẬP */}
        {currentView === 'purchase-returns' && (() => {
          const q = prSearch.trim().toLowerCase();
          const rows = prData.list.filter((r) =>
            (!q || (r.code || '').toLowerCase().includes(q) || (r.supplier_name || '').toLowerCase().includes(q) || (r.purchase_code || '').toLowerCase().includes(q)) &&
            (!prStatus || (prStatus === 'done' ? isDoneReturn(r.status) : !isDoneReturn(r.status))) &&
            (!prReason || r.reason === prReason) &&
            (!prDate || String(r.return_date || '').slice(0, 10) === prDate)
          );
          const statCard = { background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
          return (
            <div style={{ padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ margin: 0, color: '#1e293b', fontSize: '24px' }}>Trả Hàng Nhập</h2>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={loadPurchaseReturns} style={{ background: '#fff', border: '1px solid #cbd5e1', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: '500' }}>🔄 Làm mới</button>
                  <button
                    onClick={openCreatePr}
                    style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                  >+ Tạo Phiếu Trả Nhập</button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px', marginBottom: '20px' }}>
                <div style={statCard}><div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Tổng phiếu trả</div><div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0f172a' }}>{prData.stats.total}</div></div>
                <div style={statCard}><div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Tổng tiền trả</div><div style={{ fontSize: '24px', fontWeight: 'bold', color: '#dc2626' }}>{vnd(prData.stats.totalAmount)}</div></div>
                <div style={statCard}><div style={{ color: '#64748b', fontSize: '14px', marginBottom: '8px' }}>Đã hoàn thành</div><div style={{ fontSize: '24px', fontWeight: 'bold', color: '#16a34a' }}>{prData.stats.completed}</div></div>
              </div>

              <div style={{ ...statCard, display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' }}>
                <input placeholder="Tìm mã phiếu, NCC..." value={prSearch} onChange={(e) => setPrSearch(e.target.value)} style={{ flex: 1, minWidth: '200px', padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                <select value={prStatus} onChange={(e) => setPrStatus(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                  <option value="">Tất cả trạng thái</option>
                  <option value="done">Hoàn thành</option>
                  <option value="pending">Đang xử lý</option>
                </select>
                <select value={prReason} onChange={(e) => setPrReason(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                  <option value="">Tất cả lý do</option>
                  {PR_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <input type="date" value={prDate} onChange={(e) => setPrDate(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                <button onClick={loadPurchaseReturns} style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '8px 22px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Lọc</button>
              </div>

              <div style={{ background: '#fff', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', textAlign: 'left' }}>
                      <th style={{ padding: '14px' }}>MÃ PHIẾU TRẢ</th>
                      <th style={{ padding: '14px' }}>PHIẾU NHẬP GỐC</th>
                      <th style={{ padding: '14px' }}>NCC</th>
                      <th style={{ padding: '14px' }}>NGÀY TRẢ</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>TỔNG TIỀN</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>ĐÃ THU LẠI</th>
                      <th style={{ padding: '14px' }}>LÝ DO</th>
                      <th style={{ padding: '14px' }}>TRẠNG THÁI</th>
                      <th style={{ padding: '14px', textAlign: 'center' }}>THAO TÁC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr><td colSpan="9" style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>Chưa có phiếu trả hàng nhập nào.</td></tr>
                    ) : rows.map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '14px', fontWeight: 'bold' }}>{r.code}</td>
                        <td style={{ padding: '14px', color: '#475569' }}>{r.purchase_code || '-'}</td>
                        <td style={{ padding: '14px' }}>{r.supplier_name}</td>
                        <td style={{ padding: '14px' }}>{r.return_date ? new Date(r.return_date).toLocaleDateString('vi-VN') : ''}</td>
                        <td style={{ padding: '14px', textAlign: 'right', fontWeight: 'bold', color: '#dc2626' }}>{vnd(r.total_amount)}</td>
                        <td style={{ padding: '14px', textAlign: 'right', fontWeight: 'bold', color: '#16a34a' }}>{vnd(r.refund_received ?? r.received_amount)}</td>
                        <td style={{ padding: '14px' }}>{r.reason}</td>
                        <td style={{ padding: '14px' }}>
                          <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500', background: isDoneReturn(r.status) ? '#dcfce7' : '#fef3c7', color: isDoneReturn(r.status) ? '#16a34a' : '#d97706' }}>
                            {isDoneReturn(r.status) ? 'Hoàn Thành' : r.status}
                          </span>
                        </td>
                        <td style={{ padding: '14px', textAlign: 'center' }}>
                          <button title="Xem" onClick={() => handleViewPr(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', marginRight: '8px' }}>👁️</button>
                          <button title="Sửa" onClick={() => handleEditPr(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', marginRight: '8px' }}>✏️</button>
                          <button title="Xóa" onClick={() => handleDeletePr(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px' }}>🗑️</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* POPUP TẠO / SỬA PHIẾU TRẢ HÀNG NHẬP */}
        {showPrModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', width: '950px', maxHeight: '90vh', borderRadius: '12px', padding: '24px', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, color: '#1e293b' }}>{editingPrId ? '✏️ Sửa Phiếu Trả Hàng Nhập (Trả Lại NCC)' : 'Tạo Phiếu Trả Hàng Nhập (Trả Lại NCC)'}</h3>
                <button onClick={closePrModal} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label style={labelStyle}>Nhà cung cấp:</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      placeholder="Gõ tên, SĐT hoặc mã NCC..."
                      value={prSupplierSearch}
                      onChange={(e) => {
                        setPrSupplierSearch(e.target.value);
                        setPrForm((f) => ({ ...f, supplier_id: '', supplier_name: e.target.value, purchase_code: '' }));
                        setShowPrSupplierDropdown(true);
                      }}
                      onFocus={() => setShowPrSupplierDropdown(true)}
                      onBlur={() => setTimeout(() => setShowPrSupplierDropdown(false), 150)}
                      style={{ ...inputStyle, margin: 0 }}
                    />
                    {showPrSupplierDropdown && (() => {
                      const k = prSupplierSearch.trim().toLowerCase();
                      const list = (suppliers || []).filter((s) =>
                        !k || (s.name || '').toLowerCase().includes(k) || (s.phone && s.phone.includes(k)) || (s.code || '').toLowerCase().includes(k)
                      ).slice(0, 50);
                      if (list.length === 0) return null;
                      return (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '200px', overflowY: 'auto', zIndex: 20, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                          {list.map((s) => (
                            <div
                              key={s.id}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                const changed = s.id !== prForm.supplier_id;
                                setPrSupplierSearch(s.name);
                                setPrForm((f) => ({ ...f, supplier_id: s.id, supplier_name: s.name, purchase_code: changed ? '' : f.purchase_code, items: changed ? [] : f.items, refund_received: changed && !f.refund_touched ? 0 : f.refund_received }));
                                setShowPrSupplierDropdown(false);
                              }}
                              style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                            >
                              <b>{s.name}</b> <span style={{ color: '#64748b' }}>({s.code})</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Chọn phiếu nhập gốc:</label>
                  <select
                    value={(purchaseOrders.find((p) => p.code === prForm.purchase_code) || {}).id || ''}
                    onChange={(e) => handleSelectPrPurchase(e.target.value)}
                    style={{ ...inputStyle, margin: 0, background: '#fff' }}
                  >
                    <option value="">-- Chọn Phiếu Nhập Gốc --</option>
                    {(purchaseOrders || [])
                      .filter((po) => !prForm.supplier_id || po.supplier_id === prForm.supplier_id)
                      .map((po) => (
                        <option key={po.id} value={po.id}>{po.code} - {po.supplier_name || ''} ({vnd(po.total)})</option>
                      ))}
                  </select>
                </div>

                <div>
                  <label style={labelStyle}>Ngày trả:</label>
                  <input type="date" value={prForm.return_date} onChange={(e) => setPrForm({ ...prForm, return_date: e.target.value })} style={{ ...inputStyle, margin: 0 }} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label style={labelStyle}>Lý do trả:</label>
                  <select value={prForm.reason} onChange={(e) => setPrForm({ ...prForm, reason: e.target.value })} style={{ ...inputStyle, margin: 0, background: '#fff' }}>
                    {PR_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Trạng thái xử lý:</label>
                  <select value={prForm.status} onChange={(e) => setPrForm({ ...prForm, status: e.target.value })} style={{ ...inputStyle, margin: 0, background: '#fff' }}>
                    <option value={PR_DONE}>{PR_DONE}</option>
                    <option value="Đang xử lý">Đang xử lý (chưa trừ kho)</option>
                  </select>
                </div>
              </div>

              {/* Số tiền đã thu lại từ NCC + phương thức (tự ghi phiếu thu vào Thu chi) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
                <div>
                  <label style={labelStyle}>Đã thu lại tiền hoàn từ nhà cung cấp:</label>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={prForm.refund_received}
                    onChange={(e) => setPrForm({ ...prForm, refund_received: e.target.value, refund_touched: true })}
                    style={{ ...inputStyle, margin: 0 }}
                  />
                  <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                    Nhập 0 nếu chưa thu (sẽ giảm vào công nợ NCC). Số tiền &gt; 0 sẽ tự ghi một phiếu thu vào mục Thu chi.
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Phương thức nhận tiền:</label>
                  <select value={prForm.payment_method} onChange={(e) => setPrForm({ ...prForm, payment_method: e.target.value })} style={{ ...inputStyle, margin: 0, background: '#fff' }}>
                    <option value="Tiền mặt">Tiền mặt</option>
                    <option value="Chuyển khoản">Chuyển khoản</option>
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: '15px', position: 'relative' }}>
                <input
                  placeholder="🔍 Hoặc gõ mã/tên sản phẩm để thêm vào danh sách trả..."
                  value={prProductKeyword}
                  onChange={(e) => setPrProductKeyword(e.target.value)}
                  style={{ ...inputStyle, margin: 0, padding: '12px' }}
                />
                {prProductKeyword.trim() && (() => {
                  const k = prProductKeyword.trim().toLowerCase();
                  const list = (products || []).filter((p) => (p.name || '').toLowerCase().includes(k) || (p.sku && p.sku.toLowerCase().includes(k))).slice(0, 30);
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '220px', overflowY: 'auto', zIndex: 20, marginTop: '4px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                      {list.length === 0 ? (
                        <div style={{ padding: '12px', color: '#94a3b8', textAlign: 'center' }}>Không tìm thấy sản phẩm nào.</div>
                      ) : list.map((p) => (
                        <div key={p.id} onClick={() => addPrProduct(p)} style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f1f5f9' }}>
                          <span><b>{p.sku ? `${p.sku} - ` : ''}{p.name}</b> <small style={{ color: '#64748b' }}>(Tồn: {p.stock})</small></span>
                          <span style={{ color: '#7c3aed', fontWeight: 'bold' }}>{vnd(p.import_price)} <span style={{ color: '#0284c7' }}>+ Thêm</span></span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', marginBottom: '20px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', textAlign: 'left' }}>
                      <th style={{ padding: '10px 14px' }}>Mã SP</th>
                      <th style={{ padding: '10px 14px' }}>Tên Sản Phẩm</th>
                      <th style={{ padding: '10px 14px', textAlign: 'center' }}>Số lượng</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Đơn giá</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Thành tiền</th>
                      <th style={{ padding: '10px 14px', textAlign: 'center', width: '50px' }}>Xóa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prLoading ? (
                      <tr><td colSpan="6" style={{ textAlign: 'center', padding: '25px', color: '#94a3b8' }}>Đang tải sản phẩm của phiếu nhập...</td></tr>
                    ) : (prForm.items || []).length === 0 ? (
                      <tr><td colSpan="6" style={{ textAlign: 'center', padding: '25px', color: '#94a3b8' }}>Chưa có sản phẩm trả lại</td></tr>
                    ) : prForm.items.map((it, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '10px 14px' }}>{it.sku}</td>
                        <td style={{ padding: '10px 14px', fontWeight: '500' }}>{it.name}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                          <input
                            type="number" min="0" max={it.max_qty || undefined} value={it.quantity}
                            onChange={(e) => {
                              let qv = Math.max(0, Number(e.target.value) || 0);
                              if (it.max_qty) qv = Math.min(qv, it.max_qty);
                              updatePrItem(idx, { quantity: qv });
                            }}
                            style={{ width: '60px', padding: '6px', textAlign: 'center' }}
                          />
                          {it.max_qty ? <div style={{ fontSize: '11px', color: '#94a3b8' }}>tối đa {it.max_qty}</div> : null}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          <input type="number" min="0" value={it.price} onChange={(e) => updatePrItem(idx, { price: Number(e.target.value) || 0 })}
                            style={{ width: '120px', padding: '6px', textAlign: 'right', borderRadius: '4px', border: '1px solid #cbd5e1', fontWeight: 'bold' }} />
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 'bold', color: '#7c3aed' }}>{vnd(it.quantity * it.price)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                          <button onClick={() => removePrItem(idx)} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px dashed #cbd5e1', paddingTop: '15px' }}>
                <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#0f172a' }}>
                  Tổng giá trị hàng trả NCC: <span style={{ color: '#7c3aed' }}>{vnd(calcPrTotal(prForm.items))}</span>
                  <span style={{ marginLeft: '18px', fontSize: '14px' }}>
                    Còn lại trừ công nợ NCC: <span style={{ color: '#dc2626' }}>{vnd(Math.max(0, calcPrTotal(prForm.items) - (Number(prForm.refund_received) || 0)))}</span>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={closePrModal} style={{ background: '#e2e8f0', color: '#334155', border: 'none', padding: '10px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Hủy</button>
                  <button onClick={handleCreatePurchaseReturn} style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '10px 25px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>{editingPrId ? 'Cập Nhật Phiếu Trả' : 'Tạo Phiếu Trả'}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* POPUP XEM CHI TIẾT PHIẾU TRẢ HÀNG NHẬP */}
        {prDetail && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', width: '700px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#7c3aed' }}>Chi tiết: {prDetail.code}</h3>
                <button onClick={() => setPrDetail(null)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '8px', marginBottom: '15px' }}>
                <div><b>Nhà cung cấp:</b> {prDetail.supplier_name}</div>
                <div><b>Phiếu nhập gốc:</b> {prDetail.purchase_code || '---'}</div>
                <div><b>Ngày trả:</b> {prDetail.return_date ? new Date(prDetail.return_date).toLocaleDateString('vi-VN') : '---'}</div>
                <div><b>Lý do:</b> {prDetail.reason} &nbsp;|&nbsp; <b>Trạng thái:</b> {prDetail.status}</div>
                <div><b>Phương thức nhận tiền:</b> {prDetail.payment_method || 'Tiền mặt'}</div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '15px' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                    <th style={{ padding: '8px' }}>Sản phẩm</th><th style={{ padding: '8px' }}>SL</th><th style={{ padding: '8px' }}>Đơn giá</th><th style={{ padding: '8px' }}>Thành tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {(prDetail.items || []).map((it, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '8px' }}>{it.sku ? `${it.sku} - ` : ''}{it.product_name}</td>
                      <td style={{ padding: '8px' }}>{it.quantity}</td>
                      <td style={{ padding: '8px' }}>{vnd(it.price)}</td>
                      <td style={{ padding: '8px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '6px' }}>
                <span>Tổng tiền trả:</span><span style={{ color: '#dc2626' }}>{vnd(prDetail.total_amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
                <span>Đã thu lại từ NCC:</span><span style={{ color: '#16a34a' }}>{vnd(prDetail.refund_received ?? prDetail.received_amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button onClick={() => setPrDetail(null)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
              </div>
            </div>
          </div>
        )}

        {/* 2. MÀN HÌNH QUẢN LÝ SẢN PHẨM */}
        {currentView === 'products' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Sản phẩm ({products.length})</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => { setProductImportText(''); setShowProductImportModal(true); }}
                  style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  📁 Nhập Excel / Dán dữ liệu
                </button>
                <button
                  onClick={() => { setEditingProduct(null); setProductForm(EMPTY_PRODUCT); setShowProductModal(true); }}
                  style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Thêm sản phẩm mới
                </button>
              </div>
            </div>

            {/* Ô tìm kiếm sản phẩm có gợi ý */}
<div style={{ position: 'relative', marginBottom: '15px', maxWidth: '520px' }}>
  <input
    placeholder="🔍 Tìm theo mã SP hoặc tên sản phẩm..."
    value={productListSearch}
    onChange={(e) => { setProductListSearch(e.target.value); setShowProductSuggest(true); }}
    onFocus={() => setShowProductSuggest(true)}
    onBlur={() => setTimeout(() => setShowProductSuggest(false), 150)}
    style={{ ...inputStyle, margin: 0, paddingRight: productListSearch ? '36px' : '10px' }}
  />
  {productListSearch && (
    <button
      type="button"
      onClick={() => setProductListSearch('')}
      title="Xóa tìm kiếm"
      style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}
    >✕</button>
  )}
  {showProductSuggest && productSuggestions.length > 0 && (
    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '260px', overflowY: 'auto', zIndex: 20, boxShadow: '0 4px 6px rgba(0,0,0,0.1)', marginTop: '4px' }}>
      {productSuggestions.map((p) => (
        <div
          key={p.id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setProductListSearch(p.sku || p.name); setShowProductSuggest(false); }}
          style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', gap: '10px' }}
        >
          <span><b style={{ color: '#0284c7' }}>{p.sku || '(chưa có mã)'}</b> - {p.name}</span>
          <small style={{ color: '#64748b', whiteSpace: 'nowrap' }}>Tồn: {p.stock}</small>
        </div>
      ))}
    </div>
  )}
</div>
            
            <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left', position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={cellStyle}>Mã sản phẩm (SKU)</th>
                    <th style={cellStyle}>Tên sản phẩm</th>
                    <th style={cellStyle}>Đơn vị tính</th>
                    <th style={cellStyle}>Giá nhập</th>
                    <th style={cellStyle}>Giá bán lẻ</th>
                    <th style={cellStyle}>Giá bán sỉ</th>
                    <th style={cellStyle}>Tồn kho</th>
                    <th style={{ ...cellStyle, textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.length === 0 && (
  <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Không tìm thấy sản phẩm nào.</td></tr>
)}
{visibleProducts.map((p) => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      {/* Bấm vào SKU cũng mở popup chi tiết */}
                      <td
                        style={{ ...cellStyle, cursor: 'pointer', color: '#0284c7', fontWeight: '500' }}
                        onClick={() => handleOpenProductModal(p)}
                        title="Bấm để xem chi tiết & thẻ kho"
                      >
                        {p.sku}
                      </td>

                      {/* Bấm vào Tên sản phẩm sẽ mở popup chi tiết & thẻ kho */}
                      <td
                        style={{ ...cellStyle, fontWeight: 'bold', color: '#0284c7', cursor: 'pointer' }}
                        onClick={() => handleOpenProductModal(p)}
                        title="Bấm để xem chi tiết & thẻ kho"
                      >
                        {p.name}
                      </td>

                      <td style={cellStyle}>{p.unit || 'Cái'}</td>
                      <td style={cellStyle}>{vnd(p.import_price)}</td>
                      <td style={{ ...cellStyle, color: '#16a34a', fontWeight: 'bold' }}>{vnd(p.price)}</td>
                      <td style={{ ...cellStyle, color: '#0284c7' }}>{vnd(p.wholesale_price)}</td>
                      <td style={{ ...cellStyle, color: p.stock <= 3 ? '#dc2626' : 'inherit', fontWeight: p.stock <= 3 ? 'bold' : 'normal' }}>{p.stock}</td>
                      <td style={{ ...cellStyle, textAlign: 'center' }}>
                        <button
                          onClick={() => {
                            setEditingProduct(p);
                            setProductForm({ sku: p.sku || '', name: p.name, unit: p.unit || 'Cái', import_price: p.import_price || 0, price: p.price || 0, wholesale_price: p.wholesale_price || 0, stock: p.stock || 0 });
                            setShowProductModal(true);
                          }}
                          style={{ padding: '6px 12px', background: '#e0f2fe', color: '#0284c7', border: 'none', borderRadius: '4px', cursor: 'pointer', marginRight: '6px', fontWeight: '500' }}
                        >Sửa</button>
                        <button
                          onClick={() => handleDeleteProduct(p.id)}
                          style={{ padding: '6px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: '500' }}
                        >Xóa</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MÀN HÌNH QUẢN LÝ THU CHI */}
        {currentView === 'cash-book' && (
          <div style={{ padding: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
              <h2 style={{ margin: 0, color: '#0f172a' }}>Quản Lý Thu Chi ({visibleCashItems.length}{cashFiltering ? `/${cashItems.length}` : ''})</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => { setEditingCashId(null); setCashForm(newCashForm()); setShowCashModal(true); }}
                  style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Thêm Thu Chi
                </button>
                <button onClick={() => alert('Đã xuất Excel thành công!')} style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
                  📥 Xuất Excel
                </button>
              </div>
            </div>

            {/* Ô tìm kiếm + bộ lọc thời gian */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '15px' }}>
              <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: '460px' }}>
                <input
                  placeholder="🔍 Tìm theo mã NCC / KH, mã phiếu, nội dung..."
                  value={cashSearch}
                  onChange={(e) => setCashSearch(e.target.value)}
                  style={{ ...inputStyle, margin: 0, paddingRight: cashSearch ? '36px' : '10px' }}
                />
                {cashSearch && (
                  <button
                    type="button"
                    onClick={() => setCashSearch('')}
                    title="Xóa tìm kiếm"
                    style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}
                  >✕</button>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#475569' }}>Lọc theo:</span>
                <select value={cashPeriod} onChange={(e) => setCashPeriod(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                  <option value="all">Tất cả thời gian</option>
                  <option value="month">Theo tháng</option>
                  <option value="quarter">Theo quý</option>
                  <option value="year">Theo năm</option>
                  <option value="custom">Khoảng ngày</option>
                </select>

                {cashPeriod === 'month' && (
                  <input type="month" value={cashMonth} onChange={(e) => setCashMonth(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {cashPeriod === 'quarter' && (
                  <>
                    <select value={cashQuarter} onChange={(e) => setCashQuarter(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                      <option value="1">Quý 1</option>
                      <option value="2">Quý 2</option>
                      <option value="3">Quý 3</option>
                      <option value="4">Quý 4</option>
                    </select>
                    <input type="number" value={cashYear} onChange={(e) => setCashYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {cashPeriod === 'year' && (
                  <input type="number" value={cashYear} onChange={(e) => setCashYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {cashPeriod === 'custom' && (
                  <>
                    <input type="date" value={cashFrom} onChange={(e) => setCashFrom(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                    <span>đến</span>
                    <input type="date" value={cashTo} onChange={(e) => setCashTo(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {cashPeriod !== 'all' && (
                  <button type="button" onClick={() => setCashPeriod('all')} style={{ padding: '7px 12px', background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xóa lọc</button>
                )}
              </div>
            </div>

            {/* 4 ô KPI (cỡ chữ giống mục Nhà cung cấp) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px', marginBottom: '15px' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #16a34a' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG THU</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#16a34a', marginTop: '4px' }}>{vnd(cashSums.totalIn || 0)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #dc2626' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG CHI</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#dc2626', marginTop: '4px' }}>{vnd(cashSums.totalOut || 0)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #2563eb' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>LỢI NHUẬN RÒNG (THU - CHI)</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#2563eb', marginTop: '4px' }}>{vnd(cashSums.netProfit || 0)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #7c3aed' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>SỐ DƯ (TÍCH LŨY)</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#7c3aed', marginTop: '4px' }}>{vnd(cashSums.balance || 0)}</div>
              </div>
            </div>

            {/* Bảng danh sách giao dịch: vừa màn hình, dài quá thì có thanh trượt */}
            <div style={{ background: '#fff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <div style={{ padding: '12px 20px', borderBottom: '1px solid #e2e8f0', fontWeight: 'bold', fontSize: '14px', color: '#0f172a' }}>
                Danh Sách Giao Dịch
              </div>
              <FillHeight className="cash-table" bottom={40}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1', color: '#475569' }}>
                      <th style={{ padding: '12px', textAlign: 'left' }}>Mã GD</th>
                      <th style={{ padding: '12px', textAlign: 'left' }}>Ngày</th>
                      <th style={{ padding: '12px', textAlign: 'left' }}>Mã NCC / KH</th>
                      <th style={{ padding: '12px', textAlign: 'center' }}>Loại</th>
                      <th style={{ padding: '12px', textAlign: 'right' }}>Số Tiền</th>
                      <th style={{ padding: '12px', textAlign: 'left' }}>Danh Mục</th>
                      <th style={{ padding: '12px', textAlign: 'left' }}>Phương Thức TT</th>
                      <th style={{ padding: '12px', textAlign: 'left' }}>Ghi Chú</th>
                      <th style={{ padding: '12px', textAlign: 'center' }}>Thao Tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCashItems.length === 0 ? (
                      <tr>
                        <td colSpan="9" style={{ textAlign: 'center', padding: '25px', color: '#94a3b8' }}>
                          {cashFiltering ? 'Không tìm thấy giao dịch nào phù hợp.' : 'Chưa có giao dịch thu chi nào.'}
                        </td>
                      </tr>
                    ) : (
                      visibleCashItems.map((item) => (
                        <tr key={item.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '12px', fontWeight: 'bold', color: '#7c3aed' }}>{item.code}</td>
                          <td style={{ padding: '12px' }}>{item.created_at ? item.created_at.slice(0, 10) : ''}</td>
                          <td style={{ padding: '12px' }}>
                            {(() => {
                              const pt = getCashPartner(item);
                              if (!pt) return <span style={{ color: '#94a3b8' }}>-</span>;
                              return (
                                <div title={pt.name}>
                                  <b style={{ color: pt.kind === 'ncc' ? '#7c3aed' : '#0284c7' }}>{pt.code}</b>
                                  <div style={{ fontSize: '11px', color: '#64748b' }}>{pt.name}</div>
                                </div>
                              );
                            })()}
                          </td>
                          <td style={{ padding: '12px', textAlign: 'center' }}>
                            <span style={{
                              padding: '4px 10px',
                              borderRadius: '20px',
                              fontSize: '11px',
                              fontWeight: 'bold',
                              background: item.type === 'IN' ? '#dcfce7' : '#fee2e2',
                              color: item.type === 'IN' ? '#16a34a' : '#dc2626'
                            }}>
                              {item.type === 'IN' ? 'Thu' : 'Chi'}
                            </span>
                          </td>
                          <td style={{ padding: '12px', textAlign: 'right', fontWeight: 'bold', whiteSpace: 'nowrap', color: item.type === 'IN' ? '#16a34a' : '#dc2626' }}>
                            {item.type === 'IN' ? '+' : '-'}{vnd(item.amount)}
                          </td>
                          <td style={{ padding: '12px', fontWeight: '500' }}>{item.category}</td>
                          <td style={{ padding: '12px' }}>{item.payment_method}</td>
                          <td style={{ padding: '12px', color: '#475569' }}>{item.note || item.reference_code}</td>
                          <td style={{ padding: '12px', textAlign: 'center' }}>
                            <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                              <button
                                onClick={() => setSelectedCashItem(item)}
                                style={{ background: '#dbeafe', border: 'none', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', color: '#2563eb' }}
                                title="Xem chi tiết"
                              >👁️</button>
                              <button
                                onClick={() => {
                                  setEditingCashId(item.id);
                                  setCashForm({
                                    type: item.type,
                                    amount: item.amount,
                                    category: item.category,
                                    payment_method: item.payment_method || 'Chuyển khoản',
                                    reference_code: item.reference_code || '',
                                    note: item.note || '',
                                    created_at: item.created_at ? item.created_at.slice(0, 10) : todayLocal()
                                  });
                                  setShowCashModal(true);
                                }}
                                style={{ background: '#fef3c7', border: 'none', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', color: '#d97706' }}
                                title="Chỉnh sửa"
                              >✏️</button>
                              <button
                                onClick={async () => {
                                  if (confirm('Bạn có chắc muốn xóa giao dịch này?')) {
                                    try {
                                      await api(`/api/cash-book/${item.id}`, { method: 'DELETE' });
                                      loadCashBook();
                                    } catch (err) {
                                      alert('Lỗi: ' + err.message);
                                    }
                                  }
                                }}
                                style={{ background: '#fee2e2', border: 'none', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', color: '#dc2626' }}
                                title="Xóa"
                              >🗑️</button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </FillHeight>
            </div>
          </div>
        )}

        {/* POPUP CHI TIẾT SẢN PHẨM & THẺ KHO */}
        {selectedProduct && (
          <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <div className="modal-content" style={{ background: '#fff', width: '900px', maxHeight: '85vh', borderRadius: '12px', padding: '24px', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>

              {/* Header Modal & Nút đóng */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#1e293b' }}>Chi tiết sản phẩm: {selectedProduct.name}</h3>
                <button onClick={() => setSelectedProduct(null)} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
              </div>

              {/* Thanh chuyển Tab */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '2px solid #f1f5f9', paddingBottom: '10px' }}>
                <button
                  onClick={() => setActiveProductTab('info')}
                  style={{ padding: '8px 20px', background: activeProductTab === 'info' ? '#7c3aed' : '#f1f5f9', color: activeProductTab === 'info' ? '#fff' : '#475569', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  1. Thông tin sản phẩm
                </button>
                <button
                  onClick={() => setActiveProductTab('card')}
                  style={{ padding: '8px 20px', background: activeProductTab === 'card' ? '#7c3aed' : '#f1f5f9', color: activeProductTab === 'card' ? '#fff' : '#475569', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  2. Thẻ kho chi tiết
                </button>
              </div>

              {/* Nội dung Tab 1: Thông tin sản phẩm */}
              {activeProductTab === 'info' && (
                <div style={{ overflowY: 'auto', flex: 1, paddingRight: '5px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', fontSize: '15px' }}>
                    <p><strong>Mã sản phẩm (SKU):</strong> <span style={{ color: '#0284c7', fontWeight: 'bold' }}>{selectedProduct.sku || '-'}</span></p>
                    <p><strong>Tên sản phẩm:</strong> {selectedProduct.name}</p>
                    <p><strong>Danh mục / Loại:</strong> {selectedProduct.category || 'N/A'}</p>
                    <p><strong>Đơn vị tính:</strong> {selectedProduct.unit || 'Cái'}</p>
                    <p><strong>Giá mua vào:</strong> <span style={{ color: '#475569', fontWeight: 'bold' }}>{vnd(selectedProduct.import_price)}</span></p>
                    <p><strong>Giá bán lẻ:</strong> <span style={{ color: '#2563eb', fontWeight: 'bold' }}>{vnd(selectedProduct.price)}</span></p>
                    <p><strong>Giá bán sỉ:</strong> <span style={{ color: '#0284c7', fontWeight: 'bold' }}>{vnd(selectedProduct.wholesale_price)}</span></p>
                    <p><strong>Tồn kho hiện tại:</strong> <span style={{ color: '#16a34a', fontWeight: 'bold' }}>{selectedProduct.stock}</span></p>
                  </div>
                </div>
              )}

              {/* Nội dung Tab 2: Thẻ kho */}
              {activeProductTab === 'card' && (
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1', color: '#475569', textAlign: 'left' }}>
                        <th style={{ padding: '10px' }}>Mã phiếu</th>
                        <th style={{ padding: '10px' }}>Ngày</th>
                        <th style={{ padding: '10px' }}>Tên NCC / Khách hàng</th>
                        <th style={{ padding: '10px', textAlign: 'right' }}>Giá nhập</th>
                        <th style={{ padding: '10px', textAlign: 'right' }}>Giá bán</th>
                        <th style={{ padding: '10px', textAlign: 'center' }}>Số lượng</th>
                        <th style={{ padding: '10px', textAlign: 'right' }}>Tồn cuối</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockCardList.length === 0 ? (
                        <tr>
                          <td colSpan="7" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có phát sinh giao dịch thẻ kho cho sản phẩm này.</td>
                        </tr>
                      ) : (
                        stockCardList.map((item, index) => (
                          <tr key={index} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '10px', fontWeight: '500', color: '#0284c7' }}>{item.code}</td>
                            <td style={{ padding: '10px' }}>{item.date ? item.date.slice(0, 10) : ''}</td>
                            <td style={{ padding: '10px' }}>{item.partner}</td>
                            <td style={{ padding: '10px', textAlign: 'right' }}>{item.import_price > 0 ? vnd(item.import_price) : '-'}</td>
                            <td style={{ padding: '10px', textAlign: 'right' }}>{item.export_price > 0 ? vnd(item.export_price) : '-'}</td>
                            <td style={{ padding: '10px', textAlign: 'center', fontWeight: 'bold', color: item.qty > 0 ? '#16a34a' : '#dc2626' }}>
                              {item.qty > 0 ? `+${item.qty}` : item.qty}
                            </td>
                            <td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold', color: '#0f172a' }}>{item.running_stock}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

            </div>
          </div>
        )}

        {/* 3. MÀN HÌNH QUẢN LÝ NHÀ CUNG CẤP */}
        {currentView === 'suppliers' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Nhà cung cấp ({supplierRows.length}{(supplierKeyword || supRange) ? `/${suppliers.length}` : ''})</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => { setImportText(''); setShowImportModal(true); }}
                  style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  📁 Nhập Excel / Dán dữ liệu
                </button>
                <button
                  onClick={() => { setEditingSupplier(null); setSupplierForm(EMPTY_SUPPLIER); setShowSupplierModal(true); }}
                  style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Thêm nhà cung cấp
                </button>
              </div>
            </div>

            {/* Ô tìm kiếm + bộ lọc thời gian */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '15px' }}>
              <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: '460px' }}>
                <input
                  placeholder="🔍 Tìm theo tên NCC, mã NCC hoặc số điện thoại..."
                  value={supplierListSearch}
                  onChange={(e) => setSupplierListSearch(e.target.value)}
                  style={{ ...inputStyle, margin: 0, paddingRight: supplierListSearch ? '36px' : '10px' }}
                />
                {supplierListSearch && (
                  <button
                    type="button"
                    onClick={() => setSupplierListSearch('')}
                    title="Xóa tìm kiếm"
                    style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}
                  >✕</button>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#475569' }}>Lọc theo:</span>
                <select value={supPeriod} onChange={(e) => setSupPeriod(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                  <option value="all">Tất cả thời gian</option>
                  <option value="month">Theo tháng</option>
                  <option value="quarter">Theo quý</option>
                  <option value="year">Theo năm</option>
                  <option value="custom">Khoảng ngày</option>
                </select>

                {supPeriod === 'month' && (
                  <input type="month" value={supMonth} onChange={(e) => setSupMonth(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {supPeriod === 'quarter' && (
                  <>
                    <select value={supQuarter} onChange={(e) => setSupQuarter(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                      <option value="1">Quý 1</option>
                      <option value="2">Quý 2</option>
                      <option value="3">Quý 3</option>
                      <option value="4">Quý 4</option>
                    </select>
                    <input type="number" value={supYear} onChange={(e) => setSupYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {supPeriod === 'year' && (
                  <input type="number" value={supYear} onChange={(e) => setSupYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {supPeriod === 'custom' && (
                  <>
                    <input type="date" value={supFrom} onChange={(e) => setSupFrom(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                    <span>đến</span>
                    <input type="date" value={supTo} onChange={(e) => setSupTo(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {supPeriod !== 'all' && (
                  <button type="button" onClick={() => setSupPeriod('all')} style={{ padding: '7px 12px', background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xóa lọc</button>
                )}
              </div>
            </div>

            {/* 3 ô tổng hợp theo bộ lọc */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', marginBottom: '15px' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #7c3aed' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG GIÁ TRỊ NHẬP</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#7c3aed', marginTop: '4px' }}>{vnd(supplierSums.total)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #16a34a' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG ĐÃ THANH TOÁN</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#16a34a', marginTop: '4px' }}>{vnd(supplierSums.paid)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #dc2626' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>CÒN NỢ</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#dc2626', marginTop: '4px' }}>{vnd(supplierSums.debt)}</div>
              </div>
            </div>

            {/* Bảng vừa chiều ngang màn hình; dài quá thì có thanh trượt */}
            <FillHeight style={{ border: '1px solid #e2e8f0', borderRadius: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    {['Mã NCC', 'Tên NCC', 'SĐT', 'Địa chỉ', 'Tổng giá trị nhập', 'Đã thanh toán', 'Công nợ', 'Trạng thái'].map((h) => (
                      <th key={h} style={{ padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {supplierRows.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>{supRange ? 'Không có phát sinh nhập hàng trong khoảng thời gian này.' : 'Không tìm thấy nhà cung cấp nào.'}</td></tr>
                  ) : supplierRows.map((s) => (
                    <tr key={s.id} onClick={() => openSupplierDetail(s)} style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{s.code}</td>
                      <td style={{ padding: '10px 12px', fontWeight: 'bold', color: '#0284c7' }}>{s.name}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{s.phone || '-'}</td>
                      <td style={{ padding: '10px 12px', maxWidth: '220px', wordBreak: 'break-word' }}>{s.address || '-'}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{vnd(s.f_total)}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#16a34a' }}>{vnd(s.f_paid)}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: s.f_debt > 0 ? '#dc2626' : 'inherit', fontWeight: s.f_debt > 0 ? 'bold' : 'normal' }}>{vnd(s.f_debt)}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{s.status === 'active' ? 'Hoạt động' : 'Ngừng'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </FillHeight>
          </div>
        )}

        {/* 4. MÀN HÌNH QUẢN LÝ NHẬP HÀNG */}
        {currentView === 'purchases' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Nhập Hàng ({visiblePurchases.length}{purFiltering ? `/${purchaseOrders.length}` : ''})</h2>
              <button
                onClick={openCreatePurchase}
                style={{ padding: '10px 20px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                + Tạo Phiếu Nhập
              </button>
            </div>

            {/* Ô tìm kiếm + bộ lọc thời gian */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '15px' }}>
              <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: '460px' }}>
                <input
                  placeholder="🔍 Tìm theo tên NCC, mã NCC, mã phiếu nhập..."
                  value={purSearch}
                  onChange={(e) => setPurSearch(e.target.value)}
                  style={{ ...inputStyle, margin: 0, paddingRight: purSearch ? '36px' : '10px' }}
                />
                {purSearch && (
                  <button
                    type="button"
                    onClick={() => setPurSearch('')}
                    title="Xóa tìm kiếm"
                    style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}
                  >✕</button>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#475569' }}>Lọc theo:</span>
                <select value={purPeriod} onChange={(e) => setPurPeriod(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                  <option value="all">Tất cả thời gian</option>
                  <option value="month">Theo tháng</option>
                  <option value="quarter">Theo quý</option>
                  <option value="year">Theo năm</option>
                  <option value="custom">Khoảng ngày</option>
                </select>

                {purPeriod === 'month' && (
                  <input type="month" value={purMonth} onChange={(e) => setPurMonth(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {purPeriod === 'quarter' && (
                  <>
                    <select value={purQuarter} onChange={(e) => setPurQuarter(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                      <option value="1">Quý 1</option>
                      <option value="2">Quý 2</option>
                      <option value="3">Quý 3</option>
                      <option value="4">Quý 4</option>
                    </select>
                    <input type="number" value={purYear} onChange={(e) => setPurYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {purPeriod === 'year' && (
                  <input type="number" value={purYear} onChange={(e) => setPurYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {purPeriod === 'custom' && (
                  <>
                    <input type="date" value={purFrom} onChange={(e) => setPurFrom(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                    <span>đến</span>
                    <input type="date" value={purTo} onChange={(e) => setPurTo(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {purPeriod !== 'all' && (
                  <button type="button" onClick={() => setPurPeriod('all')} style={{ padding: '7px 12px', background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xóa lọc</button>
                )}
              </div>
            </div>

            {/* 3 ô tổng hợp theo bộ lọc */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', marginBottom: '15px' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #7c3aed' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG GIÁ TRỊ NHẬP</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#7c3aed', marginTop: '4px' }}>{vnd(purSums.total)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #16a34a' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG ĐÃ THANH TOÁN</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#16a34a', marginTop: '4px' }}>{vnd(purSums.paid)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #dc2626' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>CÒN NỢ</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#dc2626', marginTop: '4px' }}>{vnd(purSums.debt)}</div>
              </div>
            </div>

            <FillHeight style={{ border: '1px solid #e2e8f0', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={cellStyle}>Mã Phiếu</th>
                  <th style={cellStyle}>Ngày</th>
                  <th style={cellStyle}>Nhà Cung Cấp</th>
                  <th style={cellStyle}>Tổng Tiền</th>
                  <th style={cellStyle}>Đã Thanh Toán</th>
                  <th style={cellStyle}>Còn Nợ</th>
                  <th style={cellStyle}>Trạng Thái</th>
                  <th style={{ ...cellStyle, textAlign: 'center' }}>Thao Tác</th>
                </tr>
              </thead>
              <tbody>
                {visiblePurchases.length === 0 ? (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>{purFiltering ? 'Không tìm thấy phiếu nhập nào phù hợp.' : 'Chưa có phiếu nhập hàng nào.'}</td></tr>
                ) : (
                  visiblePurchases.map((po) => {
                    const totalAmt = Number(po.total) || 0;
                    const paidAmt = Number(po.paid_amount) || 0;
                    const debtAmt = po.debt !== undefined && po.debt !== null ? Number(po.debt) : (totalAmt - paidAmt);
                    const isPaid = debtAmt <= 0;

                    return (
                      <tr key={po.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ ...cellStyle, fontWeight: 'bold', color: '#0284c7' }}>{po.code}</td>
                        <td style={cellStyle}>{po.created_at ? new Date(po.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                        <td style={{ ...cellStyle, fontWeight: '500' }}>{po.supplier_name || '---'}</td>
                        <td style={{ ...cellStyle, fontWeight: 'bold', color: '#7c3aed' }}>{vnd(totalAmt)}</td>
                        <td style={{ ...cellStyle, color: '#16a34a' }}>{vnd(paidAmt)}</td>
                        <td style={{ ...cellStyle, color: debtAmt > 0 ? '#dc2626' : '#16a34a', fontWeight: debtAmt > 0 ? 'bold' : 'normal' }}>{vnd(debtAmt)}</td>
                        <td style={cellStyle}>
                          <span style={{ padding: '4px 10px', borderRadius: '4px', background: isPaid ? '#dcfce7' : '#fee2e2', color: isPaid ? '#166534' : '#991b1b', fontSize: '12px', fontWeight: 'bold' }}>
                            {isPaid ? 'Đã thanh toán' : 'Còn nợ'}
                          </span>
                        </td>
                        <td style={{ ...cellStyle, textAlign: 'center' }}>
                          <button
                            onClick={async () => {
                              try {
                                const details = await api(`/api/purchase_orders/${po.id}`);
                                setSelectedPurchaseOrder(details);
                                setShowViewPurchaseModal(true);
                              } catch (e) { setMsg({ type: 'err', text: e.message }); }
                            }}
                            title="Xem chi tiết"
                            style={{ background: '#e0f2fe', color: '#0284c7', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '6px' }}
                          >👁️</button>
                          <button
                            onClick={() => openEditPurchase(po)}
                            title="Chỉnh sửa"
                            style={{ background: '#fef3c7', color: '#d97706', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '6px' }}
                          >✏️</button>
                          <button
                            onClick={() => handleDeletePurchaseOrder(po.id, po.code)}
                            title="Xóa phiếu"
                            style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer' }}
                          >🗑️</button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            </FillHeight>
          </div>
        )}
        
        {/* 📊 MÀN HÌNH BÁO CÁO XUẤT - NHẬP - TỒN KHO */}
        {currentView === 'inventory-report' && (
          <div style={{ padding: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h2 style={{ margin: 0, color: '#0f172a' }}>Báo Cáo Xuất - Nhập - Tồn Kho</h2>
                <p style={{ margin: '5px 0 0 0', color: '#64748b', fontSize: '13px' }}>
                  Phương pháp tính giá xuất kho: <b style={{ color: '#0f172a' }}>Bình quân gia quyền cuối kỳ</b>
                </p>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={loadInventoryReport} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>🔄 Làm mới</button>
                <button onClick={() => alert('Đã xuất báo cáo thành công!')} style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>📥 Xuất Báo Cáo</button>
              </div>
            </div>

            {/* Các Thẻ Tổng Quan */}
            <div className="report-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px' }}>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Giá trị tồn đầu kỳ</span>
                <div style={{ fontSize: '22px', fontWeight: '900', color: '#7c3aed', marginTop: '8px' }}>{vnd(reportSummary.totalOpeningVal)}</div>
              </div>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Giá trị nhập trong kỳ</span>
                <div style={{ fontSize: '22px', fontWeight: '900', color: '#16a34a', marginTop: '8px' }}>{vnd(reportSummary.totalImportVal)}</div>
              </div>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Giá trị xuất trong kỳ (Vốn)</span>
                <div style={{ fontSize: '22px', fontWeight: '900', color: '#2563eb', marginTop: '8px' }}>{vnd(reportSummary.totalExportVal)}</div>
              </div>
              <div style={{ background: '#fff', padding: '20px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Giá trị tồn cuối kỳ</span>
                <div style={{ fontSize: '22px', fontWeight: '900', color: '#dc2626', marginTop: '8px' }}>{vnd(reportSummary.totalClosingVal)}</div>
              </div>
            </div>

            {/* Thanh Bộ Lọc Thời Gian Chi Tiết */}
            <div className="report-filter" style={{ background: '#fff', padding: '15px', borderRadius: '10px', display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', flexWrap: 'wrap' }}>
              <input
                placeholder="🔍 Tìm mã hoặc tên sản phẩm..."
                value={reportSearch}
                onChange={(e) => setReportSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadInventoryReport(); }}
                style={{ flex: 1, minWidth: '200px', padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
              />

              <div className="report-filter-range" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#475569' }}>Xem theo:</span>
                <select
                  value={reportType}
                  onChange={(e) => {
                    setReportType(e.target.value);
                    if (e.target.value === 'day') setReportValue(nowLocalISO().slice(0, 10));
                    else if (e.target.value === 'month') setReportValue(nowLocalISO().slice(0, 7));
                    else if (e.target.value === 'year') setReportValue(String(new Date().getFullYear()));
                    else if (e.target.value === 'quarter') setReportValue(`${new Date().getFullYear()}-Q1`);
                  }}
                  style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
                >
                  <option value="day">Theo Ngày</option>
                  <option value="month">Theo Tháng</option>
                  <option value="quarter">Theo Quý</option>
                  <option value="year">Theo Năm</option>
                  <option value="custom">Tùy chọn khoảng ngày</option>
                </select>

                {reportType === 'day' && (
                  <input type="date" value={reportValue} onChange={(e) => setReportValue(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {reportType === 'month' && (
                  <input type="month" value={reportValue} onChange={(e) => setReportValue(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {reportType === 'quarter' && (
                  <select value={reportValue} onChange={(e) => setReportValue(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                    <option value="2026-Q1">Quý 1 / 2026</option>
                    <option value="2026-Q2">Quý 2 / 2026</option>
                    <option value="2026-Q3">Quý 3 / 2026</option>
                    <option value="2026-Q4">Quý 4 / 2026</option>
                  </select>
                )}
                {reportType === 'year' && (
                  <input type="number" value={reportValue} onChange={(e) => setReportValue(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {reportType === 'custom' && (
                  <>
                    <input type="date" value={reportStartDate} onChange={(e) => setReportStartDate(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                    <span>đến</span>
                    <input type="date" value={reportEndDate} onChange={(e) => setReportEndDate(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
              </div>

              <button onClick={loadInventoryReport} style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Lọc dữ liệu</button>
            </div>

            {/* Bảng Chi Tiết X-N-T */}
            <div style={{ background: '#fff', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1', color: '#475569' }}>
                    <th style={{ padding: '12px', textAlign: 'left', width: '90px' }}>Mã SP</th>
                    <th style={{ padding: '12px', textAlign: 'left' }}>Tên Sản Phẩm</th>
                    <th style={{ padding: '12px', textAlign: 'center', width: '60px' }}>ĐVT</th>
                    <th colSpan="2" style={{ padding: '12px', textAlign: 'center', borderLeft: '1px solid #cbd5e1', borderRight: '1px solid #cbd5e1', background: '#f1f5f9' }}>TỒN ĐẦU KỲ</th>
                    <th colSpan="2" style={{ padding: '12px', textAlign: 'center', borderRight: '1px solid #cbd5e1', background: '#f0fdf4' }}>NHẬP TRONG KỲ</th>
                    <th colSpan="2" style={{ padding: '12px', textAlign: 'center', borderRight: '1px solid #cbd5e1', background: '#fef2f2' }}>XUẤT TRONG KỲ</th>
                    <th colSpan="2" style={{ padding: '12px', textAlign: 'center', background: '#eff6ff' }}>TỒN CUỐI KỲ</th>
                  </tr>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #cbd5e1', fontSize: '11px', color: '#64748b' }}>
                    <th colSpan="3"></th>
                    <th style={{ padding: '6px', textAlign: 'center', borderLeft: '1px solid #cbd5e1' }}>SL</th>
                    <th style={{ padding: '6px', textAlign: 'right', borderRight: '1px solid #cbd5e1' }}>Giá trị</th>
                    <th style={{ padding: '6px', textAlign: 'center' }}>SL</th>
                    <th style={{ padding: '6px', textAlign: 'right', borderRight: '1px solid #cbd5e1' }}>Giá trị</th>
                    <th style={{ padding: '6px', textAlign: 'center' }}>SL</th>
                    <th style={{ padding: '6px', textAlign: 'right', borderRight: '1px solid #cbd5e1' }}>Giá trị</th>
                    <th style={{ padding: '6px', textAlign: 'center' }}>SL</th>
                    <th style={{ padding: '6px', textAlign: 'right' }}>Giá trị</th>
                  </tr>
                </thead>
                <tbody>
                  {(!reportItems || reportItems.length === 0) ? (
                    <tr>
                      <td colSpan="11" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>
                        Không có dữ liệu sản phẩm trong khoảng thời gian này.
                      </td>
                    </tr>
                  ) : (
                    reportItems.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 'bold', color: '#7c3aed' }}>{item.code}</td>
                        <td style={{ padding: '10px 12px', fontWeight: '500' }}>{item.name}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>{item.unit}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center', borderLeft: '1px solid #e2e8f0' }}>{item.openingQty}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', borderRight: '1px solid #e2e8f0', color: '#475569' }}>{vnd(item.openingVal)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>{item.importQty}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', borderRight: '1px solid #e2e8f0', color: '#16a34a' }}>{vnd(item.importVal)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>{item.exportQty}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', borderRight: '1px solid #e2e8f0', color: '#2563eb' }}>{vnd(item.exportVal)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 'bold' }}>{item.closingQty}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 'bold', color: '#dc2626' }}>{vnd(item.closingVal)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {reportItems.length > 0 && (() => {
                  const t = reportItems.reduce((acc, it) => ({
                    openingQty: acc.openingQty + it.openingQty, openingVal: acc.openingVal + it.openingVal,
                    importQty: acc.importQty + it.importQty, importVal: acc.importVal + it.importVal,
                    exportQty: acc.exportQty + it.exportQty, exportVal: acc.exportVal + it.exportVal,
                    closingQty: acc.closingQty + it.closingQty, closingVal: acc.closingVal + it.closingVal,
                  }), { openingQty: 0, openingVal: 0, importQty: 0, importVal: 0, exportQty: 0, exportVal: 0, closingQty: 0, closingVal: 0 });
                  const qty = (n) => n.toLocaleString('vi-VN');
                  const cell = { padding: '12px', fontWeight: 'bold', background: '#f1f5f9', borderTop: '2px solid #0f172a' };
                  return (
                    <tfoot>
                      <tr>
                        <td colSpan="3" style={{ ...cell, textAlign: 'right', color: '#0f172a' }}>TỔNG CỘNG</td>
                        <td style={{ ...cell, textAlign: 'center', borderLeft: '1px solid #e2e8f0' }}>{qty(t.openingQty)}</td>
                        <td style={{ ...cell, textAlign: 'right', borderRight: '1px solid #e2e8f0', color: '#475569' }}>{vnd(t.openingVal)}</td>
                        <td style={{ ...cell, textAlign: 'center' }}>{qty(t.importQty)}</td>
                        <td style={{ ...cell, textAlign: 'right', borderRight: '1px solid #e2e8f0', color: '#16a34a' }}>{vnd(t.importVal)}</td>
                        <td style={{ ...cell, textAlign: 'center' }}>{qty(t.exportQty)}</td>
                        <td style={{ ...cell, textAlign: 'right', borderRight: '1px solid #e2e8f0', color: '#2563eb' }}>{vnd(t.exportVal)}</td>
                        <td style={{ ...cell, textAlign: 'center' }}>{qty(t.closingQty)}</td>
                        <td style={{ ...cell, textAlign: 'right', color: '#dc2626' }}>{vnd(t.closingVal)}</td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>
          </div>
        )}

        {/* ⚙️ MÀN HÌNH CÀI ĐẶT THÔNG TIN DOANH NGHIỆP & LOGO */}
        {currentView === 'settings' && (
          <div style={{ background: '#fff', padding: '30px', borderRadius: '12px', maxWidth: '700px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginTop: 0, color: '#7c3aed', marginBottom: '20px' }}>⚙️ Cài đặt thông tin doanh nghiệp & Logo in hóa đơn</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Tên doanh nghiệp đầy đủ (In trên hóa đơn):</label>
                <input
                  value={companyInfo.name}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, name: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Tên thương hiệu ngắn (Brand):</label>
                <input
                  value={companyInfo.brand}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, brand: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Phụ đề / Slogan:</label>
                <input
                  value={companyInfo.subtitle}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, subtitle: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Link ảnh Logo (URL hoặc Base64):</label>
                <input
                  placeholder="Dán đường dẫn ảnh hoặc mã Base64 vào đây"
                  value={companyInfo.logoUrl}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, logoUrl: e.target.value })}
                  style={inputStyle}
                />
                {companyInfo.logoUrl && (
                  <div style={{ marginTop: '10px', padding: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '15px' }}>
                    <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>Xem trước Logo:</span>
                    <img
                      src={companyInfo.logoUrl}
                      alt="Logo Preview"
                      style={{ maxHeight: '50px', maxWidth: '200px', objectFit: 'contain', background: '#fff', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    />
                  </div>
                )}
              </div>

              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Địa chỉ công ty:</label>
                <input
                  value={companyInfo.address}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, address: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Mã số thuế (MST):</label>
                <input
                  value={companyInfo.taxCode}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, taxCode: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Số điện thoại liên hệ:</label>
                <input
                  value={companyInfo.phone}
                  onChange={(e) => setCompanyInfo({ ...companyInfo, phone: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>

            <button
              onClick={() => {
                localStorage.setItem('company_info', JSON.stringify(companyInfo));
                setMsg({ type: 'ok', text: 'Đã lưu cài đặt thông tin doanh nghiệp thành công!' });
                alert('Đã lưu thông tin doanh nghiệp thành công!');
              }}
              style={{ padding: '12px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '15px' }}
            >
              💾 Lưu Thay Đổi
            </button>
          </div>
        )}

        {/* 📊 MÀN HÌNH BÁO CÁO KẾT QUẢ KINH DOANH (LÃI / LỖ) */}
        {currentView === 'profit-loss-report' && (
          <div style={{ padding: '20px', background: '#f8fafc', minHeight: '100vh', borderRadius: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '15px' }}>
              <h2 style={{ margin: 0, color: '#1e293b' }}>📊 Báo Cáo Kết Quả Kinh Doanh (Lãi / Lỗ)</h2>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span>Từ ngày:</span>
                <input type="date" value={plStartDate} onChange={e => setPlStartDate(e.target.value)} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                <span>Đến ngày:</span>
                <input type="date" value={plEndDate} onChange={e => setPlEndDate(e.target.value)} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                <button onClick={loadProfitLossReport} style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xem báo cáo</button>
              </div>
            </div>

            <div style={{ background: '#fff', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', maxWidth: '800px', margin: '0 auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '15px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#64748b' }}>
                    <th style={{ textAlign: 'left', padding: '12px' }}>Chỉ tiêu</th>
                    <th style={{ textAlign: 'right', padding: '12px' }}>Thành tiền (VNĐ)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', fontWeight: 'bold' }}>
                    <td style={{ padding: '12px' }}>1. Doanh thu bán hàng</td>
                    <td style={{ textAlign: 'right', padding: '12px', color: '#2563eb' }}>{vnd(plReport.grossRevenue)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', color: '#64748b' }}>
                    <td style={{ padding: '12px', paddingLeft: '25px' }}>- Các khoản giảm trừ (Giảm giá / Trả lại)</td>
                    <td style={{ textAlign: 'right', padding: '12px' }}>{vnd(plReport.totalDiscount)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', fontWeight: 'bold', background: '#f8fafc' }}>
                    <td style={{ padding: '12px' }}>2. Doanh thu thuần (Net Revenue)</td>
                    <td style={{ textAlign: 'right', padding: '12px', color: '#0284c7' }}>{vnd(plReport.netRevenue)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', fontWeight: 'bold' }}>
                    <td style={{ padding: '12px' }}>3. Giá vốn hàng bán (COGS)</td>
                    <td style={{ textAlign: 'right', padding: '12px', color: '#dc2626' }}>-{vnd(plReport.cogs)}</td>
                  </tr>
                  <tr style={{ borderBottom: '2px solid #cbd5e1', fontWeight: 'bold', background: '#f0fdf4' }}>
                    <td style={{ padding: '12px' }}>4. Lợi nhuận gộp (Gross Profit)</td>
                    <td style={{ textAlign: 'right', padding: '12px', color: '#16a34a', fontSize: '16px' }}>{vnd(plReport.grossProfit)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '12px', fontWeight: 'bold' }} colSpan="2">5. Tổng chi phí hoạt động:</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', color: '#64748b' }}>
                    <td style={{ padding: '10px', paddingLeft: '25px' }}>+ Chi phí vận chuyển (Ship)</td>
                    <td style={{ textAlign: 'right', padding: '10px' }}>-{vnd(plReport.expenses.shipping)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', color: '#64748b' }}>
                    <td style={{ padding: '10px', paddingLeft: '25px' }}>+ Chi phí thuế</td>
                    <td style={{ textAlign: 'right', padding: '10px' }}>-{vnd(plReport.expenses.tax)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', color: '#64748b' }}>
                    <td style={{ padding: '10px', paddingLeft: '25px' }}>+ Chi phí lương nhân viên</td>
                    <td style={{ textAlign: 'right', padding: '10px' }}>-{vnd(plReport.expenses.salary)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f1f5f9', color: '#64748b' }}>
                    <td style={{ padding: '10px', paddingLeft: '25px' }}>+ Chi phí quản lý / khác</td>
                    <td style={{ textAlign: 'right', padding: '10px' }}>-{vnd(plReport.expenses.other)}</td>
                  </tr>
                  <tr style={{ borderBottom: '2px solid #cbd5e1', fontWeight: 'bold', background: '#f8fafc' }}>
                    <td style={{ padding: '12px', paddingLeft: '25px' }}>Tổng chi phí</td>
                    <td style={{ textAlign: 'right', padding: '12px', color: '#dc2626' }}>-{vnd(plReport.expenses.total)}</td>
                  </tr>
                  <tr style={{ borderTop: '3px double #0f172a', fontWeight: 'bold', background: '#eff6ff' }}>
                    <td style={{ padding: '15px', fontSize: '16px' }}>6. LỢI NHUẬN THUẦN (NET PROFIT)</td>
                    <td style={{ textAlign: 'right', padding: '15px', fontSize: '18px', color: plReport.netProfit >= 0 ? '#16a34a' : '#dc2626' }}>
                      {vnd(plReport.netProfit)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 5. MÀN HÌNH QUẢN LÝ KHÁCH HÀNG */}
        {currentView === 'customers' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Khách hàng ({customerRows.length}{(customerKeyword || cusRange) ? `/${customers.length}` : ''})</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => { setCustomerImportText(''); setShowCustomerImportModal(true); }} style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>📁 Nhập Excel / Dán dữ liệu</button>
                <button onClick={() => { setEditingCustomer(null); setCustomerForm(EMPTY_CUSTOMER); setShowCustomerModal(true); }} style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>+ Thêm khách hàng</button>
              </div>
            </div>

            {/* Ô tìm kiếm + bộ lọc thời gian */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '15px' }}>
              <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: '460px' }}>
                <input
                  placeholder="🔍 Tìm theo tên khách, mã KH hoặc số điện thoại..."
                  value={customerListSearch}
                  onChange={(e) => setCustomerListSearch(e.target.value)}
                  style={{ ...inputStyle, margin: 0, paddingRight: customerListSearch ? '36px' : '10px' }}
                />
                {customerListSearch && (
                  <button
                    type="button"
                    onClick={() => setCustomerListSearch('')}
                    title="Xóa tìm kiếm"
                    style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}
                  >✕</button>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#475569' }}>Lọc theo:</span>
                <select value={cusPeriod} onChange={(e) => setCusPeriod(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                  <option value="all">Tất cả thời gian</option>
                  <option value="month">Theo tháng</option>
                  <option value="quarter">Theo quý</option>
                  <option value="year">Theo năm</option>
                  <option value="custom">Khoảng ngày</option>
                </select>

                {cusPeriod === 'month' && (
                  <input type="month" value={cusMonth} onChange={(e) => setCusMonth(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {cusPeriod === 'quarter' && (
                  <>
                    <select value={cusQuarter} onChange={(e) => setCusQuarter(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                      <option value="1">Quý 1</option>
                      <option value="2">Quý 2</option>
                      <option value="3">Quý 3</option>
                      <option value="4">Quý 4</option>
                    </select>
                    <input type="number" value={cusYear} onChange={(e) => setCusYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {cusPeriod === 'year' && (
                  <input type="number" value={cusYear} onChange={(e) => setCusYear(e.target.value)} style={{ width: '80px', padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                )}
                {cusPeriod === 'custom' && (
                  <>
                    <input type="date" value={cusFrom} onChange={(e) => setCusFrom(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                    <span>đến</span>
                    <input type="date" value={cusTo} onChange={(e) => setCusTo(e.target.value)} style={{ padding: '7px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                  </>
                )}
                {cusPeriod !== 'all' && (
                  <button type="button" onClick={() => setCusPeriod('all')} style={{ padding: '7px 12px', background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xóa lọc</button>
                )}
              </div>
            </div>

            {/* 3 ô tổng hợp theo bộ lọc */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', marginBottom: '15px' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #7c3aed' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG GIÁ TRỊ MUA</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#7c3aed', marginTop: '4px' }}>{vnd(customerSums.total)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #16a34a' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>TỔNG ĐÃ THANH TOÁN</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#16a34a', marginTop: '4px' }}>{vnd(customerSums.paid)}</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', borderLeft: '4px solid #dc2626' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 'bold' }}>CÒN NỢ</div>
                <div style={{ fontSize: '18px', fontWeight: '900', color: '#dc2626', marginTop: '4px' }}>{vnd(customerSums.debt)}</div>
              </div>
            </div>

            {/* Bảng vừa chiều ngang màn hình; dài quá thì có thanh trượt */}
            <FillHeight style={{ border: '1px solid #e2e8f0', borderRadius: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    {['Mã KH', 'Tên khách hàng', 'Số điện thoại', 'Địa chỉ', 'Tổng mua', 'Đã thanh toán', 'Công nợ'].map((h) => (
                      <th key={h} style={{ padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                    <th style={{ padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {customerRows.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>{cusRange ? 'Không có phát sinh bán hàng trong khoảng thời gian này.' : (customerKeyword ? 'Không tìm thấy khách hàng nào.' : 'Chưa có khách hàng nào.')}</td></tr>
                  ) : (
                    customerRows.map((c) => (
                      <tr key={c.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{c.code}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 'bold', color: '#0284c7', cursor: 'pointer' }} onClick={() => openCustomerDetail(c)}>{c.name}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{c.phone || '-'}</td>
                        <td style={{ padding: '10px 12px', maxWidth: '220px', wordBreak: 'break-word' }}>{c.address || '-'}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{vnd(c.f_total)}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#16a34a' }}>{vnd(c.f_paid)}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: c.f_debt > 0 ? '#dc2626' : '#16a34a', fontWeight: c.f_debt > 0 ? 'bold' : 'normal' }}>{vnd(c.f_debt)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                          <button onClick={() => { setEditingCustomer(c); setCustomerForm({ code: c.code, name: c.name, phone: c.phone || '', address: c.address || '' }); setShowCustomerModal(true); }} title="Sửa" style={{ background: '#fef3c7', color: '#d97706', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '6px' }}>✏️</button>
                          <button onClick={() => handleDeleteCustomer(c.id, c.name)} title="Xóa" style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer' }}>🗑️</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                </table>  
              </FillHeight>
            </div>
        )}

                {/* MÀN HÌNH PHIẾU BẢO HÀNH */}
        {currentView === 'warranties' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
              <h2 style={{ margin: 0 }}>Phiếu bảo hành ({visibleWarranties.length}{(wKeyword || warrantyFilter !== 'all') ? `/${warranties.length}` : ''})</h2>
              <button onClick={() => openWarrantyModal()} style={{ padding: '10px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>+ Tạo phiếu bảo hành</button>
            </div>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '15px' }}>
              <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: '460px' }}>
                <input
                  placeholder="🔍 Tìm theo mã BH, mã phiếu bán, khách, SĐT, sản phẩm, số khung..."
                  value={warrantySearch}
                  onChange={(e) => setWarrantySearch(e.target.value)}
                  style={{ ...inputStyle, margin: 0, paddingRight: warrantySearch ? '36px' : '10px' }}
                />
                {warrantySearch && (
                  <button type="button" onClick={() => setWarrantySearch('')} title="Xóa tìm kiếm" style={{ position: 'absolute', right: '6px', top: '6px', background: 'transparent', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#64748b' }}>✕</button>
                )}
              </div>
              <select value={warrantyFilter} onChange={(e) => setWarrantyFilter(e.target.value)} style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}>
                <option value="all">Tất cả tình trạng</option>
                <option value="valid">Còn hạn</option>
                <option value="soon">Sắp hết hạn (≤ 30 ngày)</option>
                <option value="expired">Hết hạn</option>
              </select>
            </div>

            <FillHeight style={{ border: '1px solid #e2e8f0', borderRadius: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    {['Mã BH', 'Mã phiếu bán', 'Khách hàng', 'Sản phẩm', 'Ngày mua', 'Thời hạn', 'Ngày hết hạn', 'Tình trạng'].map((h) => (
                      <th key={h} style={{ padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                    <th style={{ padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWarranties.length === 0 ? (
                    <tr><td colSpan="9" style={{ textAlign: 'center', padding: '25px', color: '#94a3b8' }}>{warranties.length === 0 ? 'Chưa có phiếu bảo hành nào.' : 'Không tìm thấy phiếu bảo hành phù hợp.'}</td></tr>
                  ) : visibleWarranties.map((w) => {
                    const st = warrantyStatus(w.expiry_date);
                    return (
                      <tr key={w.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td onClick={() => setWarrantyDetail(w)} style={{ padding: '10px 12px', fontWeight: 'bold', color: '#7c3aed', cursor: 'pointer', whiteSpace: 'nowrap' }}>{w.code}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#0284c7' }}>{w.invoice_code || '-'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <b>{w.customer_name}</b>
                          <div style={{ fontSize: '11px', color: '#64748b' }}>{w.customer_phone || ''}</div>
                        </td>
                        <td style={{ padding: '10px 12px', maxWidth: '260px' }}>
                          {(w.items || []).map((it, i) => <div key={i}>{it.name} <span style={{ color: '#64748b' }}>x{it.quantity}</span></div>)}
                        </td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{fmtDMY(w.purchase_date)}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{w.duration} {UNIT_LABEL[w.unit] || ''}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 'bold' }}>{fmtDMY(w.expiry_date)}</td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                          <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', background: st.bg, color: st.color }}>{st.text}</span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                          <button onClick={() => setWarrantyDetail(w)} title="Xem" style={smallBtn('#e0f2fe', '#0284c7')}>👁️</button>
                          <button onClick={() => editWarranty(w)} title="Sửa" style={smallBtn('#fef3c7', '#d97706')}>✏️</button>
                          <button onClick={() => deleteWarranty(w)} title="Xóa" style={smallBtn('#fee2e2', '#dc2626')}>🗑️</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </FillHeight>
          </div>
        )}

        {/* POPUP TẠO / SỬA PHIẾU BẢO HÀNH */}
{showWarrantyModal && warrantyForm && (
  <div style={overlayStyle}>
    <div style={{ background: '#fff', width: '760px', maxHeight: '92vh', borderRadius: '8px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 10px 25px rgba(0,0,0,0.2)', fontSize: '13px' }}>
      <div style={{ padding: '0 14px', height: '40px', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0' }}>
        <h3 style={{ margin: 0, fontSize: '15px', color: '#16a34a' }}>{editingWarrantyId ? '✏️ Sửa phiếu bảo hành' : '🛡️ Tạo phiếu bảo hành'}</h3>
        <button onClick={() => { setShowWarrantyModal(false); setEditingWarrantyId(null); }} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>

      <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>

        {/* Thông tin phiếu + khách hàng */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
          <div>
            <label style={cLabel}>Mã phiếu bảo hành</label>
            <input value={warrantyForm.code} onChange={(e) => setWarrantyForm({ ...warrantyForm, code: e.target.value })} style={cInput} />
          </div>
          <div>
            <label style={cLabel}>Mã phiếu bán hàng liên quan</label>
            <select value={warrantyForm.invoice_code} onChange={(e) => handleSelectWarrantyInvoice(e.target.value)} style={{ ...cInput, background: '#fff' }}>
              <option value="">-- Chọn phiếu bán hàng --</option>
              {warrantyForm.invoice_code && !(invoicesList || []).some((i) => i.code === warrantyForm.invoice_code) && (
                <option value={warrantyForm.invoice_code}>{warrantyForm.invoice_code}</option>
              )}
              {(invoicesList || []).map((i) => (
                <option key={i.id} value={i.code}>{i.code} - {i.customer_name || 'Khách lẻ'} ({vnd(i.total)})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={cLabel}>Tên khách hàng *</label>
            <input value={warrantyForm.customer_name} onChange={(e) => setWarrantyForm({ ...warrantyForm, customer_name: e.target.value })} style={cInput} />
          </div>
          <div>
            <label style={cLabel}>Số điện thoại</label>
            <input value={warrantyForm.customer_phone} onChange={(e) => setWarrantyForm({ ...warrantyForm, customer_phone: e.target.value })} style={cInput} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={cLabel}>Địa chỉ</label>
            <input value={warrantyForm.address} onChange={(e) => setWarrantyForm({ ...warrantyForm, address: e.target.value })} style={cInput} />
          </div>
        </div>

        {/* Ngày mua + thời hạn + ngày hết hạn */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 10px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '8px 10px' }}>
          <div>
            <label style={cLabel}>Ngày mua hàng</label>
            <input type="date" value={warrantyForm.purchase_date} onChange={(e) => setWarrantyForm({ ...warrantyForm, purchase_date: e.target.value })} style={cInput} />
          </div>
          <div>
            <label style={cLabel}>Thời gian bảo hành</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input type="number" min="1" value={warrantyForm.duration} onChange={(e) => setWarrantyForm({ ...warrantyForm, duration: e.target.value })} style={{ ...cInput, flex: 1, minWidth: 0 }} />
              <select value={warrantyForm.unit} onChange={(e) => setWarrantyForm({ ...warrantyForm, unit: e.target.value })} style={{ ...cInput, width: '80px', flexShrink: 0, background: '#fff' }}>
                <option value="month">Tháng</option>
                <option value="year">Năm</option>
                <option value="day">Ngày</option>
              </select>
            </div>
          </div>
          <div>
            <label style={cLabel}>Ngày hết hạn bảo hành</label>
            <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#16a34a', lineHeight: '30px' }}>
              {fmtDMY(addWarrantyDuration(warrantyForm.purchase_date, warrantyForm.duration, warrantyForm.unit))}
            </div>
          </div>
        </div>

        {/* Sản phẩm được bảo hành */}
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700, margin: '2px 0 4px 0' }}>
            Sản phẩm được bảo hành <span style={{ fontWeight: 'normal', fontSize: '11px', color: '#64748b' }}>(bấm ✕ để bỏ sản phẩm không bảo hành)</span>
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'auto', maxHeight: '200px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                  <th style={cTh}>Mã SP</th>
                  <th style={cTh}>Tên sản phẩm</th>
                  <th style={{ ...cTh, width: '64px' }}>SL</th>
                  <th style={cTh}>Số khung / số sườn / ghi chú</th>
                  <th style={{ ...cTh, width: '40px', textAlign: 'center' }}>Bỏ</th>
                </tr>
              </thead>
              <tbody>
                {warrantyForm.items.length === 0 ? (
                  <tr><td colSpan="5" style={{ ...cTd, textAlign: 'center', padding: '16px', color: '#94a3b8' }}>Chưa có sản phẩm. Hãy chọn phiếu bán hàng ở trên.</td></tr>
                ) : warrantyForm.items.map((it, idx) => (
                  <tr key={idx} style={{ borderTop: '1px solid #eef0f5' }}>
                    <td style={cTd}>{it.sku}</td>
                    <td style={{ ...cTd, fontWeight: 500 }}>{it.name}</td>
                    <td style={cTd}>
                      <input type="number" min="1" value={it.quantity} onChange={(e) => setWarrantyForm({ ...warrantyForm, items: warrantyForm.items.map((x, i) => (i === idx ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)) })} style={{ ...cCell, width: '52px', textAlign: 'center' }} />
                    </td>
                    <td style={cTd}>
                      <input value={it.detail || ''} onChange={(e) => setWarrantyForm({ ...warrantyForm, items: warrantyForm.items.map((x, i) => (i === idx ? { ...x, detail: e.target.value } : x)) })} style={{ ...cCell, width: '100%', textAlign: 'left' }} />
                    </td>
                    <td style={{ ...cTd, textAlign: 'center' }}>
                      <button onClick={() => setWarrantyForm({ ...warrantyForm, items: warrantyForm.items.filter((_, i) => i !== idx) })} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', width: '24px', height: '24px', borderRadius: '4px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Ghi chú */}
        <div>
          <label style={cLabel}>Ghi chú / điều kiện bảo hành</label>
          <textarea rows="2" value={warrantyForm.note || ''} onChange={(e) => setWarrantyForm({ ...warrantyForm, note: e.target.value })} style={{ ...cInput, height: 'auto', padding: '6px 8px', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        {/* Nút hành động */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={() => { setShowWarrantyModal(false); setEditingWarrantyId(null); }} style={{ height: '32px', padding: '0 16px', background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}>Hủy</button>
          <button onClick={saveWarranty} style={{ height: '32px', padding: '0 18px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}>{editingWarrantyId ? 'Cập nhật phiếu' : 'Lưu phiếu bảo hành'}</button>
        </div>
      </div>
    </div>
  </div>
)}

        {/* POPUP XEM CHI TIẾT PHIẾU BẢO HÀNH */}
        {warrantyDetail && (() => {
          const w = warrantyDetail;
          const st = warrantyStatus(w.expiry_date);
          return (
            <div style={overlayStyle}>
              <div style={{ background: '#fff', width: '700px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', overflowY: 'auto', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <h3 style={{ margin: 0, color: '#16a34a' }}>Phiếu bảo hành: {w.code}</h3>
                  <button onClick={() => setWarrantyDetail(null)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
                </div>
                <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '8px', marginBottom: '15px', lineHeight: 1.8 }}>
                  <div><b>Phiếu bán hàng:</b> {w.invoice_code || '---'}</div>
                  <div><b>Khách hàng:</b> {w.customer_name} ({w.customer_phone || 'Chưa có SĐT'})</div>
                  <div><b>Địa chỉ:</b> {w.address || '---'}</div>
                  <div><b>Ngày mua:</b> {fmtDMY(w.purchase_date)} &nbsp;|&nbsp; <b>Thời hạn:</b> {w.duration} {UNIT_LABEL[w.unit] || ''}</div>
                  <div><b>Ngày hết hạn:</b> <span style={{ color: '#16a34a', fontWeight: 'bold' }}>{fmtDMY(w.expiry_date)}</span> &nbsp;
                    <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', background: st.bg, color: st.color }}>{st.text}</span>
                  </div>
                  {w.note ? <div><b>Ghi chú:</b> {w.note}</div> : null}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead><tr style={{ background: '#f1f5f9', textAlign: 'left' }}><th style={{ padding: '8px' }}>Sản phẩm</th><th style={{ padding: '8px' }}>SL</th><th style={{ padding: '8px' }}>Số khung / số sườn / ghi chú</th></tr></thead>
                  <tbody>
                    {(w.items || []).map((it, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '8px' }}>{it.sku ? `${it.sku} - ` : ''}{it.name}</td>
                        <td style={{ padding: '8px' }}>{it.quantity}</td>
                        <td style={{ padding: '8px', color: '#7c3aed', fontStyle: 'italic' }}>{it.detail || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                  <button onClick={() => { setWarrantyDetail(null); editWarranty(w); }} style={{ padding: '8px 16px', background: '#fef3c7', color: '#d97706', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>✏️ Sửa</button>
                  <button onClick={() => setWarrantyDetail(null)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
                </div>
              </div>
            </div>
          );
        })()}
        
        {/* POPUP XEM CHI TIẾT PHIẾU NHẬP */}
        {showViewPurchaseModal && selectedPurchaseOrder && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', width: '800px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#7c3aed' }}>Chi tiết Phiếu Nhập: {selectedPurchaseOrder.code}</h3>
                <button onClick={() => setShowViewPurchaseModal(false)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px', background: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
                <div><b>Nhà cung cấp:</b> {selectedPurchaseOrder.supplier_name || '---'}</div>
                <div><b>Ngày tạo:</b> {selectedPurchaseOrder.created_at ? new Date(selectedPurchaseOrder.created_at).toLocaleString('vi-VN') : '---'}</div>
                <div><b>Phương thức thanh toán:</b> {selectedPurchaseOrder.payment_method || 'Tiền mặt'}</div>
              </div>

              <h4 style={{ margin: '10px 0' }}>Danh sách sản phẩm nhập</h4>
              <div style={{ maxHeight: '250px', overflowY: 'auto', marginBottom: '15px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                      <th style={{ padding: '8px' }}>SKU</th>
                      <th style={{ padding: '8px' }}>Tên sản phẩm</th>
                      <th style={{ padding: '8px' }}>Số lượng</th>
                      <th style={{ padding: '8px' }}>Đơn giá</th>
                      <th style={{ padding: '8px' }}>Giảm giá</th>
                      <th style={{ padding: '8px' }}>Thành tiền</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedPurchaseOrder.items || []).map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '8px' }}>{item.sku}</td>
                        <td style={{ padding: '8px', fontWeight: '500' }}>{item.product_name}</td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>{item.quantity}</td>
                        <td style={{ padding: '8px' }}>{vnd(item.price)}</td>
                        <td style={{ padding: '8px' }}>{vnd(item.discount)}</td>
                        <td style={{ padding: '8px', fontWeight: 'bold', color: '#16a34a' }}>{vnd((item.quantity * item.price) - (item.discount || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', marginBottom: '15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}><span>Tổng tiền hàng:</span> <b>{vnd(selectedPurchaseOrder.total)}</b></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}><span>Đã thanh toán:</span> <span>{vnd(selectedPurchaseOrder.paid_amount)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Còn nợ:</span> <b style={{ color: selectedPurchaseOrder.debt > 0 ? '#dc2626' : '#16a34a' }}>{vnd(selectedPurchaseOrder.debt)}</b></div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowViewPurchaseModal(false)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
              </div>
            </div>
          </div>
        )}

        {/* POPUP THÊM NHANH NHÀ CUNG CẤP (đặt ở cấp ngoài cùng để không bị lồng trong popup phiếu nhập) */}
        {showQuickAddSupplierModal && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
            <div style={{ background: '#fff', width: '400px', borderRadius: '12px', padding: '20px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
              <h3 style={{ margin: '0 0 15px 0', color: '#7c3aed' }}>Thêm Nhanh Nhà Cung Cấp</h3>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Tên nhà cung cấp *:</label>
                <input
                  placeholder="Nhập tên công ty / cửa hàng..."
                  value={newSupplierForm.name}
                  onChange={(e) => setNewSupplierForm({ ...newSupplierForm, name: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Số điện thoại:</label>
                <input
                  placeholder="Nhập số điện thoại..."
                  value={newSupplierForm.phone}
                  onChange={(e) => setNewSupplierForm({ ...newSupplierForm, phone: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Địa chỉ:</label>
                <input
                  placeholder="Nhập địa chỉ..."
                  value={newSupplierForm.address}
                  onChange={(e) => setNewSupplierForm({ ...newSupplierForm, address: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  onClick={() => setShowQuickAddSupplierModal(false)}
                  style={{ padding: '8px 16px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  Hủy
                </button>
                <button
                  onClick={handleQuickSaveSupplier}
                  style={{ padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  Lưu nhà cung cấp
                </button>
              </div>
            </div>
          </div>
        )}

{/* POPUP TẠO / SỬA PHIẾU NHẬP HÀNG */}
{showCreatePurchaseModal && (
  <div style={overlayStyle}>
    <div style={{ background: '#fff', width: '760px', maxHeight: '90vh', borderRadius: '8px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', fontSize: '13px' }}>
      <div style={{ padding: '0 14px', height: '40px', flexShrink: 0, background: '#7c3aed', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '15px' }}>{editingPurchaseId ? 'Chỉnh sửa Phiếu Nhập Hàng' : 'Tạo Phiếu Nhập Hàng'}</h3>
        <button onClick={() => setShowCreatePurchaseModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>

      <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1 }}>
        {/* Khối thông tin phiếu */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px', marginBottom: '8px', padding: '8px 10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
          <div style={{ position: 'relative' }}>
            <label style={cLabel}>Nhà cung cấp *</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                placeholder="Nhập tên, SĐT hoặc mã NCC..."
                value={supplierSearchKeyword}
                onChange={(e) => {
                  setSupplierSearchKeyword(e.target.value);
                  setPurchaseForm((f) => ({ ...f, supplier_id: '' }));
                  setShowSupplierDropdown(true);
                }}
                onFocus={() => setShowSupplierDropdown(true)}
                onBlur={() => setTimeout(() => setShowSupplierDropdown(false), 150)}
                style={{ ...cInput, flex: 1 }}
              />
              <button
                type="button"
                onClick={() => setShowQuickAddSupplierModal(true)}
                title="Thêm nhà cung cấp mới"
                style={{ height: '30px', padding: '0 10px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', whiteSpace: 'nowrap' }}
              >+ Thêm</button>
            </div>

            {showSupplierDropdown && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '150px', overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                {(suppliers || []).filter((s) =>
                  s.name.toLowerCase().includes(supplierSearchKeyword.toLowerCase()) ||
                  (s.phone && s.phone.includes(supplierSearchKeyword)) ||
                  (s.code || '').toLowerCase().includes(supplierSearchKeyword.toLowerCase())
                ).map((s) => (
                  <div
                    key={s.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setPurchaseForm((f) => ({ ...f, supplier_id: s.id }));
                      setSupplierSearchKeyword(`${s.name} (${s.code})`);
                      setShowSupplierDropdown(false);
                    }}
                    style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}
                  >
                    <b>{s.name}</b> <span style={{ color: '#64748b' }}>({s.code})</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label style={cLabel}>Phương thức thanh toán</label>
            <select
              value={purchaseForm.payment_method}
              onChange={(e) => setPurchaseForm({ ...purchaseForm, payment_method: e.target.value })}
              style={cInput}
            >
              <option value="Tiền mặt">Tiền mặt</option>
              <option value="Chuyển khoản">Chuyển khoản</option>
              <option value="Công nợ">Công nợ</option>
            </select>
          </div>

          <div>
            <label style={cLabel}>Ngày nhập hàng</label>
            <input
              type="datetime-local"
              value={purchaseForm.created_at ? purchaseForm.created_at.slice(0, 16) : nowLocalISO().slice(0, 16)}
              onChange={(e) => setPurchaseForm({ ...purchaseForm, created_at: e.target.value })}
              style={cInput}
            />
          </div>
        </div>

        {/* Tìm sản phẩm */}
        <div style={{ marginBottom: '8px' }}>
          <label style={cLabel}>Tìm kiếm sản phẩm để thêm vào phiếu nhập</label>
          <input
            placeholder="Nhập tên sản phẩm hoặc mã SKU..."
            value={productSearchKeyword}
            onChange={(e) => setProductSearchKeyword(e.target.value)}
            style={cInput}
          />
          {productSearchKeyword.trim() && (
            <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '140px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
              {(products || []).filter((p) =>
                p.name.toLowerCase().includes(productSearchKeyword.toLowerCase()) ||
                (p.sku && p.sku.toLowerCase().includes(productSearchKeyword.toLowerCase()))
              ).map((p) => (
                <div
                  key={p.id}
                  onClick={() => {
                    const exist = purchaseItems.find((item) => item.product_id === p.id);
                    if (exist) {
                      setPurchaseItems(purchaseItems.map((item) => item.product_id === p.id ? { ...item, quantity: item.quantity + 1 } : item));
                    } else {
                      setPurchaseItems([...purchaseItems, { product_id: p.id, name: p.name, sku: p.sku, unit: p.unit || 'Cái', quantity: 1, price: p.import_price || p.price || 0, discount: 0 }]);
                    }
                    setProductSearchKeyword('');
                  }}
                  style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}
                >
                  <span><b>{p.name}</b> (SKU: {p.sku})</span>
                  <span style={{ color: '#0284c7', fontWeight: 'bold' }}>+ Thêm</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bảng sản phẩm nhập */}
        <div style={{ marginBottom: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'auto', maxHeight: '240px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                <th style={cTh}>SKU</th>
                <th style={cTh}>Tên sản phẩm</th>
                <th style={cTh}>ĐVT</th>
                <th style={{ ...cTh, width: '64px' }}>SL</th>
                <th style={{ ...cTh, width: '110px' }}>Đơn giá</th>
                <th style={{ ...cTh, width: '90px' }}>Giảm</th>
                <th style={cTh}>Thành tiền</th>
                <th style={{ ...cTh, width: '40px', textAlign: 'center' }}>Xóa</th>
              </tr>
            </thead>
            <tbody>
              {purchaseItems.length === 0 ? (
                <tr><td colSpan="8" style={{ ...cTd, textAlign: 'center', padding: '14px', color: '#94a3b8' }}>Chưa có sản phẩm nào trong phiếu nhập.</td></tr>
              ) : (
                purchaseItems.map((item, index) => {
                  const lineTotal = (item.quantity * item.price) - item.discount;
                  return (
                    <tr key={item.product_id ?? index} style={{ borderTop: '1px solid #eef0f5' }}>
                      <td style={cTd}>{item.sku}</td>
                      <td style={{ ...cTd, fontWeight: 500 }}>{item.name}</td>
                      <td style={cTd}>{item.unit}</td>
                      <td style={cTd}>
                        <input type="number" min="1" value={item.quantity} onChange={(e) => updatePurchaseItem(index, { quantity: Math.max(1, Number(e.target.value) || 1) })} style={{ ...cCell, width: '52px', textAlign: 'center' }} />
                      </td>
                      <td style={cTd}>
                        <input type="number" value={item.price} onChange={(e) => updatePurchaseItem(index, { price: Number(e.target.value) || 0 })} style={{ ...cCell, width: '100px' }} />
                      </td>
                      <td style={cTd}>
                        <input type="number" value={item.discount} onChange={(e) => updatePurchaseItem(index, { discount: Number(e.target.value) || 0 })} style={{ ...cCell, width: '80px' }} />
                      </td>
                      <td style={{ ...cTd, fontWeight: 'bold', color: '#16a34a', whiteSpace: 'nowrap' }}>{vnd(lineTotal)}</td>
                      <td style={{ ...cTd, textAlign: 'center' }}>
                        <button onClick={() => setPurchaseItems(purchaseItems.filter((_, idx) => idx !== index))} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', width: '24px', height: '24px', borderRadius: '4px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Chân phiếu: Tổng / Đã trả / Nợ / Hoàn tất */}
        {(() => {
          const totalAmount = purchaseItems.reduce((sum, item) => sum + ((item.quantity * item.price) - item.discount), 0);
          const debtAmount = totalAmount - (Number(purchaseForm.paid_amount) || 0);

          return (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', background: '#f8fafc', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div><span style={{ color: '#64748b' }}>Tổng: </span><b>{vnd(totalAmount)}</b></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: '#64748b' }}>Đã trả: </span>
                  <input type="number" value={purchaseForm.paid_amount} onChange={(e) => setPurchaseForm({ ...purchaseForm, paid_amount: e.target.value })} style={{ ...cCell, width: '110px', fontWeight: 'bold' }} />
                </div>
                <div><span style={{ color: '#64748b' }}>Nợ: </span><b style={{ color: debtAmount > 0 ? '#dc2626' : '#16a34a' }}>{vnd(Math.max(0, debtAmount))}</b></div>
              </div>

              <button
                onClick={handleSavePurchase}
                style={{ height: '32px', padding: '0 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
              >
                💾 Hoàn tất
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  </div>
)}

        {/* POPUP TẠO PHIẾU THU / CHI */}
        {showCashModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '500px' }}>
              <h3 style={{ marginTop: 0, color: '#0f172a' }}>{editingCashId ? 'Chỉnh Sửa Phiếu Thu / Chi' : 'Tạo Phiếu Thu / Chi Mới'}</h3>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loại giao dịch:</label>
                <select
                  value={cashForm.type}
                  onChange={(e) => {
                    const t = e.target.value;
                    // Đổi loại thì đặt lại danh mục mặc định cho đúng loại
                    setCashForm({ ...cashForm, type: t, category: t === 'OUT' ? 'Mua hàng / Trả nợ NCC' : 'Bán hàng / Thu nợ KH' });
                  }}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  <option value="OUT">Phiếu Chi (Trả NCC, Lương, Vận chuyển, Thuế...)</option>
                  <option value="IN">Phiếu Thu (Thu tiền khách, Khác...)</option>
                </select>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Danh mục:</label>
                <select
                  value={cashForm.category}
                  onChange={(e) => setCashForm({ ...cashForm, category: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  {cashForm.type === 'OUT' ? (
                    <>
                      <option value="Mua hàng / Trả nợ NCC">Mua hàng / Trả nợ NCC</option>
                      <option value="Chi hoàn trả khách hàng">Chi hoàn trả khách hàng</option>
                      <option value="Chi phí vận chuyển">Chi phí vận chuyển</option>
                      <option value="Chi thuế">Chi thuế</option>
                      <option value="Chi lương nhân viên">Chi lương nhân viên</option>
                      <option value="Chi phí khác">Chi phí khác</option>
                    </>
                  ) : (
                    <>
                      <option value="Bán hàng / Thu nợ KH">Bán hàng / Thu nợ KH</option>
                      <option value="Thu hoàn tiền NCC">Thu hoàn tiền NCC</option>
                      <option value="Thu hoàn trả từ NCC">Thu hoàn trả từ NCC</option>
                      <option value="Thu nhập khác">Thu nhập khác</option>
                    </>
                  )}
                </select>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Số tiền (VNĐ):</label>
              
                            
              {/* Chọn NCC khi là phiếu liên quan nhà cung cấp (lưu mã NCC vào ô chứng từ liên quan) */}
              {String(cashForm.category || '').includes('NCC') && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Nhà cung cấp:</label>
                  <select
                    value={(suppliers || []).some((s) => s.code === cashForm.reference_code) ? cashForm.reference_code : ''}
                    onChange={(e) => setCashForm({ ...cashForm, reference_code: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                  >
                    <option value="">-- Không chọn --</option>
                    {(suppliers || []).map((s) => <option key={s.id} value={s.code}>{s.name} ({s.code})</option>)}
                  </select>
                </div>
              )}

              {/* Phiếu liên quan khách hàng -> chọn KH (lưu mã KH vào ô chứng từ liên quan) */}
              {/KH|khách/i.test(String(cashForm.category || '')) && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Khách hàng:</label>
                  <select
                    value={(customers || []).some((c) => c.code === cashForm.reference_code) ? cashForm.reference_code : ''}
                    onChange={(e) => setCashForm({ ...cashForm, reference_code: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                  >
                    <option value="">-- Không chọn --</option>
                    {(customers || []).map((c) => <option key={c.id} value={c.code}>{c.name} ({c.code})</option>)}
                  </select>
                </div>
              )}
                
                <input
                  type="number"
                  placeholder="Nhập số tiền..."
                  value={cashForm.amount}
                  onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Phương thức thanh toán:</label>
                <select
                  value={cashForm.payment_method}
                  onChange={(e) => setCashForm({ ...cashForm, payment_method: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  <option value="Chuyển khoản">Chuyển khoản</option>
                  <option value="Tiền mặt">Tiền mặt</option>
                </select>
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500', color: '#334155', fontSize: '13px' }}>
                  Ngày giao dịch:
                </label>
                <input
                  type="date"
                  value={cashForm.created_at ? cashForm.created_at.slice(0, 10) : todayLocal()}
                  onChange={(e) => setCashForm({ ...cashForm, created_at: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    fontSize: '14px',
                    boxSizing: 'border-box',
                    outline: 'none',
                    background: '#fff'
                  }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Ghi chú / Chứng từ liên quan:</label>
                <textarea
                  rows="3"
                  placeholder="Nhập nội dung giải trình..."
                  value={cashForm.note}
                  onChange={(e) => setCashForm({ ...cashForm, note: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button onClick={() => setShowCashModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
                <button
                  onClick={async () => {
                    if (!cashForm.amount || Number(cashForm.amount) <= 0) {
                      alert('Vui lòng nhập số tiền hợp lệ!');
                      return;
                    }
                    try {
                      await api(editingCashId ? `/api/cash-book/${editingCashId}` : '/api/cash-book', {
                        method: editingCashId ? 'PUT' : 'POST',
                        body: JSON.stringify(cashForm)
                      });
                      setShowCashModal(false);
                      setEditingCashId(null);
                      setCashForm(newCashForm());
                      loadCashBook();
                    } catch (err) {
                      alert('Lỗi: ' + err.message);
                    }
                  }}
                  style={{ padding: '8px 20px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  {editingCashId ? 'Cập nhật giao dịch' : 'Lưu giao dịch'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* POPUP TẠO / SỬA PHIẾU BÁN HÀNG / ĐƠN ĐẶT HÀNG (zIndex 900 để các popup thêm SP/KH hiện lên trên) */}
{showOrderModal && (
  <div style={{ ...overlayStyle, zIndex: 900 }}>
    <div style={{ background: '#fff', width: '820px', maxHeight: '92vh', borderRadius: '8px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', fontSize: '13px' }}>
      <div style={{ padding: '0 14px', height: '40px', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0' }}>
        <h3 style={{ margin: 0, fontSize: '15px', color: modalOrderType === 'invoices' ? '#16a34a' : '#7c3aed' }}>
          {modalOrderType === 'invoices'
            ? (editingInvoiceId ? '✏️ Sửa Phiếu Bán Hàng' : '📦 Tạo Phiếu Bán Hàng (trừ tồn kho)')
            : (editingOrderId ? '✏️ Sửa Đơn Đặt Hàng' : '📝 Tạo Đơn Đặt Hàng (không trừ kho)')}
        </h3>
        <button onClick={() => { setShowOrderModal(false); setEditingOrderId(null); setEditingInvoiceId(null); setEditingInvoiceOriginalQty({}); }} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>

      <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>

        {/* Ô tìm sản phẩm có gợi ý */}
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              placeholder="🔍 Gõ mã hoặc tên sản phẩm để thêm vào phiếu..."
              value={posProductKeyword}
              onChange={(e) => { setPosProductKeyword(e.target.value); setShowPosSuggest(true); }}
              onFocus={() => setShowPosSuggest(true)}
              onBlur={() => setTimeout(() => setShowPosSuggest(false), 150)}
              style={cInput}
            />
            <button
              onClick={() => { setEditingProduct(null); setProductForm(EMPTY_PRODUCT); setShowProductModal(true); }}
              title="Thêm sản phẩm mới"
              style={{ height: '30px', width: '36px', flexShrink: 0, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
            >+</button>
          </div>

          {showPosSuggest && posProductKeyword.trim() && (() => {
            const k = removeAccents(posProductKeyword.trim());
            const list = (products || []).filter((p) =>
              removeAccents(p.sku).includes(k) || removeAccents(p.name).includes(k)
            ).slice(0, 10);
            return (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: '42px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '260px', overflowY: 'auto', zIndex: 30, marginTop: '3px', boxShadow: '0 4px 10px rgba(0,0,0,0.15)' }}>
                {list.length === 0 ? (
                  <div style={{ padding: '10px', color: '#94a3b8', textAlign: 'center' }}>Không tìm thấy sản phẩm nào.</div>
                ) : list.map((p) => {
                  const out = p.stock <= 0;
                  return (
                    <div
                      key={p.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { add(p); setPosProductKeyword(''); setShowPosSuggest(false); }}
                      style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', background: out ? '#fffbeb' : '#fff' }}
                    >
                      <div>
                        <b style={{ color: '#0f172a' }}>{p.sku ? `${p.sku} - ` : ''}{p.name}</b><br />
                        <small style={{ color: out ? '#dc2626' : '#64748b', fontSize: '11px' }}>
                          {out ? (modalOrderType === 'invoices' ? 'Hết hàng' : 'Hết (Cho phép đặt)') : `Tồn: ${p.stock}`} | ĐVT: {p.unit || 'Cái'}
                        </small>
                      </div>
                      <div style={{ textAlign: 'right', fontWeight: 'bold', color: '#7c3aed', whiteSpace: 'nowrap' }}>
                        {vnd(p.price)} <span style={{ color: '#0284c7' }}>+ Thêm</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Chọn từ đơn đặt hàng (chỉ khi tạo phiếu bán) */}
        {modalOrderType === 'invoices' && (
          <div style={{ background: '#f0fdf4', padding: '6px 10px', borderRadius: '6px', border: '1px solid #bbf7d0' }}>
            <label style={{ ...cLabel, color: '#16a34a' }}>Chọn từ Đơn Đặt Hàng trước đó (nếu có):</label>
            <select onChange={(e) => handleSelectOrderToInvoice(e.target.value)} style={cInput}>
              <option value="">-- Chọn đơn đặt hàng để xuất bán --</option>
              {ordersList.map((o) => (
                <option key={o.id} value={o.id}>{o.code} - {o.customer_name} ({vnd(o.total)})</option>
              ))}
            </select>
          </div>
        )}

        {/* Ngày tạo + Khách hàng */}
        <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '8px 10px' }}>
          <div>
            <label style={cLabel}>Ngày tạo</label>
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} style={cInput} />
          </div>
          <div style={{ position: 'relative' }}>
            <label style={cLabel}>Khách hàng</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                placeholder="Gõ tên, SĐT hoặc mã khách hàng..."
                value={customerSearch}
                onChange={(e) => {
                  setCustomerSearch(e.target.value);
                  setPosCustomer((c) => ({ ...c, name: e.target.value }));
                  setShowCustomerDropdown(true);
                }}
                onFocus={() => setShowCustomerDropdown(true)}
                onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 150)}
                style={cInput}
              />
              <button
                onClick={() => { setEditingCustomer(null); setCustomerForm({ ...EMPTY_CUSTOMER, name: customerSearch }); setShowCustomerModal(true); }}
                title="Thêm khách hàng mới"
                style={{ height: '30px', width: '36px', flexShrink: 0, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
              >+</button>
            </div>
            {showCustomerDropdown && filteredPosCustomers.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: '42px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '160px', overflowY: 'auto', zIndex: 20, marginTop: '3px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                {filteredPosCustomers.map((c) => (
                  <div
                    key={c.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setPosCustomer({ name: c.name, phone: c.phone || '', address: c.address || '' });
                      setCustomerSearch(c.name);
                      setShowCustomerDropdown(false);
                    }}
                    style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                  >
                    <b>{c.name}</b> - <span style={{ color: '#64748b' }}>{c.phone || 'Chưa có SĐT'} ({c.code})</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* SĐT + Địa chỉ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
          <div>
            <label style={cLabel}>Số điện thoại</label>
            <input value={posCustomer.phone} onChange={(e) => setPosCustomer({ ...posCustomer, phone: e.target.value })} placeholder="SĐT khách hàng..." style={cInput} />
          </div>
          <div>
            <label style={cLabel}>Địa chỉ</label>
            <input value={posCustomer.address} onChange={(e) => setPosCustomer({ ...posCustomer, address: e.target.value })} placeholder="Địa chỉ khách hàng..." style={cInput} />
          </div>
        </div>

        {/* Chi tiết đơn hàng */}
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700, margin: '2px 0 4px 0' }}>Chi tiết đơn hàng</div>
          <div style={{ minHeight: '90px', maxHeight: '210px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                  <th style={cTh}>Sản phẩm</th>
                  <th style={{ ...cTh, width: '64px' }}>SL</th>
                  <th style={{ ...cTh, width: '110px' }}>Đơn giá</th>
                  <th style={{ ...cTh, width: '90px' }}>Giảm giá</th>
                  <th style={cTh}>Thành tiền</th>
                  <th style={{ ...cTh, width: '40px', textAlign: 'center' }}>Xóa</th>
                </tr>
              </thead>
              <tbody>
                {cartLines.length === 0 ? (
                  <tr><td colSpan="6" style={{ ...cTd, textAlign: 'center', padding: '22px', color: '#94a3b8' }}>Chưa có sản phẩm nào</td></tr>
                ) : (
                  cartLines.map((l) => (
                    <tr key={l.id} style={{ borderTop: '1px solid #eef0f5' }}>
                      <td style={cTd}>
                        <div style={{ fontWeight: 500 }}>{l.name}</div>
                        {(cart[l.id + '_chassis'] || cart[l.id + '_frame'] || cart[l.id + '_color'] || cart[l.id + '_note']) && (
                          <div style={{ fontSize: '11px', color: '#7c3aed', fontStyle: 'italic', margin: '2px 0' }}>
                            {[
                              cart[l.id + '_chassis'] ? `Số khung: ${cart[l.id + '_chassis']}` : '',
                              cart[l.id + '_frame'] ? `Số sườn: ${cart[l.id + '_frame']}` : '',
                              cart[l.id + '_color'] ? `Màu: ${cart[l.id + '_color']}` : '',
                              cart[l.id + '_note'] ? `Ghi chú: ${cart[l.id + '_note']}` : ''
                            ].filter(Boolean).join(' | ')}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => setActiveChassisProduct(l.id)}
                          style={{ background: '#f3e8ff', color: '#7c3aed', border: '1px dashed #d8b4fe', padding: '1px 6px', borderRadius: '4px', fontSize: '10.5px', fontWeight: 'bold', cursor: 'pointer', marginTop: '2px' }}
                        >
                          ✏️ + Thêm số khung, số sườn, ghi chú
                        </button>
                      </td>
                      <td style={cTd}>
                        <input type="number" min="1" value={l.quantity} onChange={(e) => setQty(l.id, Math.max(1, Number(e.target.value) || 1))} style={{ ...cCell, width: '52px', textAlign: 'center' }} />
                      </td>
                      <td style={cTd}>
                        <input type="number" value={l.price} onChange={(e) => setItemPrice(l.id, e.target.value)} style={{ ...cCell, width: '100px', fontWeight: 'bold', color: '#7c3aed' }} />
                      </td>
                      <td style={cTd}>
                        <input type="number" value={l.discount} onChange={(e) => setDiscount(l.id, e.target.value)} style={{ ...cCell, width: '80px' }} />
                      </td>
                      <td style={{ ...cTd, fontWeight: 'bold', color: '#16a34a', whiteSpace: 'nowrap' }}>{vnd((l.price * l.quantity) - l.discount)}</td>
                      <td style={{ ...cTd, textAlign: 'center' }}>
                        <button onClick={() => setQty(l.id, 0)} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', width: '24px', height: '24px', borderRadius: '4px', cursor: 'pointer', lineHeight: 1 }}>✕</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Tổng cộng + thanh toán */}
        <div style={{ background: '#f8fafc', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '15px', fontWeight: 'bold', marginBottom: '6px' }}>
            <span>TỔNG CỘNG:</span>
            <span style={{ color: '#7c3aed' }}>{vnd(cartTotal)}</span>
          </div>

          {depositFromOrder > 0 && modalOrderType === 'invoices' && (() => {
            const remain = Math.max(0, cartTotal - depositFromOrder);
            const extra = Math.max(0, (Number(paidAmount) || 0) - depositFromOrder);
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 10px', alignItems: 'start' }}>
                <div>
                  <label style={cLabel}>Đã tạm ứng (từ đơn đặt hàng):</label>
                  <div style={{ fontWeight: 'bold', color: '#16a34a' }}>{vnd(depositFromOrder)}</div>
                </div>
                <div>
                  <label style={cLabel}>Còn phải thanh toán:</label>
                  <div style={{ fontWeight: 'bold', color: '#7c3aed' }}>{vnd(remain)}</div>
                </div>
                <div>
                  <label style={cLabel}>Thanh toán thêm lần này:</label>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={extra || ''}
                    onChange={(e) => setPaidAmount(depositFromOrder + Math.max(0, Number(e.target.value) || 0))}
                    style={{ ...cInput, fontWeight: 'bold' }}
                  />
                </div>
                <div>
                  <label style={cLabel}>Còn nợ đơn này:</label>
                  <div style={{ fontWeight: 'bold', color: remain - extra > 0 ? '#dc2626' : '#16a34a' }}>{vnd(Math.max(0, remain - extra))}</div>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={cLabel}>Phương thức TT (khoản thanh toán thêm):</label>
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} style={cInput}>
                    <option value="Tiền mặt">💵 Tiền mặt</option>
                    <option value="Chuyển khoản">🏦 Chuyển khoản</option>
                    <option value="Công nợ">📒 Công nợ</option>
                  </select>
                </div>
              </div>
            );
          })()}

          <div style={{ display: (depositFromOrder > 0 && modalOrderType === 'invoices') ? 'none' : 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px 10px', alignItems: 'start' }}>
            <div>
              <label style={cLabel}>Khách đã thanh toán:</label>
              <input type="number" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} style={{ ...cInput, fontWeight: 'bold' }} />
            </div>
            <div>
              <label style={cLabel}>Còn nợ đơn này:</label>
              <div style={{ fontWeight: 'bold', lineHeight: '30px', color: cartDebt > 0 ? '#dc2626' : '#16a34a' }}>{vnd(cartDebt)}</div>
            </div>
            <div>
              <label style={cLabel}>Phương thức TT:</label>
              <select
                value={paymentMethod}
                onChange={(e) => { setPaymentMethod(e.target.value); if (e.target.value === 'Công nợ') setPaidAmount(0); }}
                style={cInput}
              >
                <option value="Tiền mặt">💵 Tiền mặt</option>
                <option value="Chuyển khoản">🏦 Chuyển khoản</option>
                <option value="Công nợ">📒 Công nợ</option>
              </select>
            </div>
          </div>
        </div>

        <button
          disabled={busy || cartLines.length === 0}
          onClick={handlePosSubmit}
          style={{ width: '100%', height: '38px', background: modalOrderType === 'invoices' ? '#16a34a' : '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: busy || cartLines.length === 0 ? 'not-allowed' : 'pointer', opacity: busy || cartLines.length === 0 ? 0.6 : 1, fontWeight: 'bold', fontSize: '14px' }}
        >
          {modalOrderType === 'invoices'
            ? (editingInvoiceId ? 'CẬP NHẬT PHIẾU BÁN HÀNG' : 'XÁC NHẬN TẠO PHIẾU BÁN HÀNG')
            : (editingOrderId ? 'CẬP NHẬT ĐƠN ĐẶT HÀNG' : 'XÁC NHẬN TẠO ĐƠN ĐẶT HÀNG')}
        </button>
      </div>
    </div>
  </div>
)}

        {/* MODAL THÊM / SỬA SẢN PHẨM */}
        {showProductModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '10px', width: '500px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '20px' }}>{editingProduct ? 'Chỉnh sửa sản phẩm' : 'Thêm sản phẩm mới'}</h3>
              <form onSubmit={handleSaveProduct}>
                <div style={{ marginBottom: '12px' }}>
                  <label style={labelStyle}>Mã sản phẩm (SKU):</label>
                  <input placeholder="VD: SKU001" value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} style={inputStyle} />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={labelStyle}>Tên sản phẩm *:</label>
                  <input placeholder="Nhập tên sản phẩm" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} style={inputStyle} required />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                  <div>
                    <label style={labelStyle}>Đơn vị tính:</label>
                    <input placeholder="Cái, Bộ, Chiếc..." value={productForm.unit} onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Tồn kho:</label>
                    <input type="number" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} style={inputStyle} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
                  <div>
                    <label style={labelStyle}>Giá nhập:</label>
                    <input type="number" value={productForm.import_price} onChange={(e) => setProductForm({ ...productForm, import_price: e.target.value })} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Giá bán lẻ:</label>
                    <input type="number" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Giá bán sỉ:</label>
                    <input type="number" value={productForm.wholesale_price} onChange={(e) => setProductForm({ ...productForm, wholesale_price: e.target.value })} style={inputStyle} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button type="button" onClick={() => setShowProductModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Hủy</button>
                  <button type="submit" style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Lưu sản phẩm</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* POPUP TÙY CHỌN THÔNG TIN SẢN PHẨM (SỐ KHUNG, SỐ SƯỜN, MÀU SẮC, GHI CHÚ) */}
        {activeChassisProduct && (() => {
          const prod = cartLines.find(l => l.id === activeChassisProduct);
          if (!prod) return null;

          return (
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1200 }}>
              <div style={{ background: '#fff', width: '450px', borderRadius: '10px', padding: '20px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '10px', marginBottom: '15px' }}>
                  <h4 style={{ margin: 0, color: '#0f172a' }}>Tùy chọn thông tin sản phẩm</h4>
                  <button onClick={() => setActiveChassisProduct(null)} style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer' }}>✕</button>
                </div>

                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#7c3aed', marginBottom: '15px' }}>
                  Sản phẩm: {prod.name}
                </div>

                {/* Ô nhập Số khung */}
                <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ width: '90px', fontSize: '13px', fontWeight: '500' }}>Số khung:</label>
                  <input
                    type="text"
                    placeholder="Nhập số khung..."
                    value={cart[prod.id + '_chassis'] || ''}
                    onChange={(e) => setCart(c => ({ ...c, [prod.id + '_chassis']: e.target.value }))}
                    style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  />
                </div>

                {/* Ô nhập Số sườn */}
                <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ width: '90px', fontSize: '13px', fontWeight: '500' }}>Số sườn:</label>
                  <input
                    type="text"
                    placeholder="Nhập số sườn..."
                    value={cart[prod.id + '_frame'] || ''}
                    onChange={(e) => setCart(c => ({ ...c, [prod.id + '_frame']: e.target.value }))}
                    style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  />
                </div>

                {/* Ô nhập Màu sắc */}
                <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ width: '90px', fontSize: '13px', fontWeight: '500' }}>Màu sắc:</label>
                  <input
                    type="text"
                    placeholder="Nhập màu sắc..."
                    value={cart[prod.id + '_color'] || ''}
                    onChange={(e) => setCart(c => ({ ...c, [prod.id + '_color']: e.target.value }))}
                    style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  />
                </div>

                {/* Ô nhập Ghi chú */}
                <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ width: '90px', fontSize: '13px', fontWeight: '500' }}>Ghi chú:</label>
                  <input
                    type="text"
                    placeholder="Nhập ghi chú khác..."
                    value={cart[prod.id + '_note'] || ''}
                    onChange={(e) => setCart(c => ({ ...c, [prod.id + '_note']: e.target.value }))}
                    style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button
                    onClick={() => setActiveChassisProduct(null)}
                    style={{ padding: '8px 20px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    Xong
                  </button>
                </div>

              </div>
            </div>
          );
        })()}

        {/* MODAL IMPORT SẢN PHẨM */}
        {showProductImportModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Nhập khẩu danh sách Sản phẩm</h3>
              <p style={{ fontSize: '13px', color: '#64748b' }}>Copy từ Excel dán vào theo thứ tự: <code style={{ background: '#f1f5f9', padding: '2px 4px' }}>SKU | Tên | ĐVT | Giá nhập | Giá lẻ | Giá sỉ | Tồn kho</code></p>
              <textarea rows="8" placeholder={'SKU001\tẮc quy 48V\tBộ\t1500000\t1800000\t1700000\t10'} value={productImportText} onChange={(e) => setProductImportText(e.target.value)} style={{ width: '100%', padding: '10px', fontFamily: 'monospace', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '15px' }}>
                <button onClick={() => setShowProductImportModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
                <button
                  onClick={() => runImport({
                    text: productImportText,
                    endpoint: '/api/products/import',
                    label: 'sản phẩm',
                    close: setShowProductImportModal,
                    mapRow: (c) => c.length >= 2 ? { sku: c[0], name: c[1], unit: c[2] || 'Cái', import_price: num(c[3]), price: num(c[4]), wholesale_price: num(c[5]), stock: num(c[6]) } : null,
                  })}
                  style={{ padding: '8px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >Xác nhận</button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL NHÀ CUNG CẤP */}
        {showSupplierModal && !anyChildOpen && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', width: '800px', maxHeight: '90vh', borderRadius: '12px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '20px', background: '#1e293b', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{editingSupplier ? `Chi tiết: ${selectedSupplier?.name}` : 'Thêm nhà cung cấp mới'}</h3>
                <button onClick={() => setShowSupplierModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer' }}>✕</button>
              </div>

              {editingSupplier ? (
                <>
                  <div style={{ display: 'flex', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0' }}>
                    <button onClick={() => setSupplierTab('info')} style={tabBtnStyle(supplierTab === 'info')}>1. Thông tin NCC</button>
                    <button onClick={() => setSupplierTab('purchases')} style={tabBtnStyle(supplierTab === 'purchases')}>2. Lịch sử nhập hàng</button>
                    <button onClick={() => setSupplierTab('payments')} style={tabBtnStyle(supplierTab === 'payments')}>3. Lịch sử thanh toán</button>
                    <button onClick={() => setSupplierTab('returns')} style={tabBtnStyle(supplierTab === 'returns')}>4. Lịch sử trả hàng</button>
                  </div>

                  <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
                    {supplierTab === 'info' && (
                      <form onSubmit={handleSaveSupplier}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                          <div><label>Mã NCC</label><input value={supplierForm.code || ''} onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} style={inputStyle} /></div>
                          <div><label>Tên nhà cung cấp *</label><input value={supplierForm.name || ''} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} style={inputStyle} required /></div>
                          <div><label>Số điện thoại</label><input value={supplierForm.phone || ''} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} style={inputStyle} /></div>
                          <div>
                            <label>Trạng thái</label>
                            <select value={supplierForm.status || 'active'} onChange={(e) => setSupplierForm({ ...supplierForm, status: e.target.value })} style={inputStyle}>
                              <option value="active">Hoạt động</option>
                              <option value="inactive">Ngừng</option>
                            </select>
                          </div>
                          <div style={{ gridColumn: 'span 2' }}><label>Địa chỉ</label><input value={supplierForm.address || ''} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} style={inputStyle} /></div>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                          <button type="submit" style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Cập nhật</button>
                          <button type="button" onClick={() => handleDeleteSupplier(selectedSupplier.id)} style={{ padding: '10px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Xóa NCC</button>
                        </div>
                      </form>
                    )}

                    {supplierTab === 'purchases' && (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                            <th style={{ padding: '8px' }}>Mã phiếu</th>
                            <th style={{ padding: '8px' }}>Tổng tiền</th>
                            <th style={{ padding: '8px' }}>Ngày tạo</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>Thao tác</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(supplierHistory.purchases || []).length === 0 ? (
                            <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có phiếu nhập nào.</td></tr>
                          ) : (supplierHistory.purchases || []).map((p) => (
                            <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                              <td onClick={() => viewPurchaseFromSupplier(p)} style={{ padding: '8px', fontWeight: 'bold', color: '#0284c7', cursor: 'pointer' }} title="Bấm để xem chi tiết">{p.code}</td>
                              <td style={{ padding: '8px' }}>{vnd(p.total)}</td>
                              <td style={{ padding: '8px' }}>{fmtDT(p.created_at)}</td>
                              <td style={{ padding: '8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                                <button onClick={() => viewPurchaseFromSupplier(p)} title="Xem" style={smallBtn('#e0f2fe', '#0284c7')}>👁️</button>
                                <button onClick={() => editPurchaseFromSupplier(p)} title="Sửa" style={smallBtn('#fef3c7', '#d97706')}>✏️</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {supplierTab === 'payments' && (() => {
                      const rows = getSupplierPaymentRows();
                      return (
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                              <th style={{ padding: '8px' }}>Mã</th>
                              <th style={{ padding: '8px' }}>Ngày</th>
                              <th style={{ padding: '8px' }}>Loại</th>
                              <th style={{ padding: '8px', textAlign: 'right' }}>Số tiền</th>
                              <th style={{ padding: '8px' }}>Phương thức</th>
                              <th style={{ padding: '8px' }}>Ghi chú</th>
                              <th style={{ padding: '8px', textAlign: 'center' }}>Thao tác</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.length === 0 ? (
                              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có lịch sử thanh toán.</td></tr>
                            ) : rows.map((r) => (
                              <tr key={r.key} style={{ borderBottom: '1px solid #e2e8f0' }}>
                                <td style={{ padding: '8px', fontWeight: 'bold', color: '#7c3aed' }}>{r.code}</td>
                                <td style={{ padding: '8px' }}>{r.date ? new Date(r.date).toLocaleDateString('vi-VN') : '---'}</td>
                                <td style={{ padding: '8px' }}>
                                  <span style={{ padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 'bold', background: r.type === 'IN' ? '#dcfce7' : '#fee2e2', color: r.type === 'IN' ? '#16a34a' : '#dc2626' }}>
                                    {r.type === 'IN' ? 'Thu tiền hoàn' : 'Trả tiền hàng'}
                                  </span>
                                </td>
                                <td style={{ padding: '8px', textAlign: 'right', fontWeight: 'bold', color: r.type === 'IN' ? '#16a34a' : '#dc2626' }}>{r.type === 'IN' ? '+' : '-'}{vnd(r.amount)}</td>
                                <td style={{ padding: '8px' }}>{r.method || '---'}</td>
                                <td style={{ padding: '8px', color: '#475569' }}>{r.note || '---'}</td>
                                <td style={{ padding: '8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                                  {r.kind === 'none' ? '---' : (
                                    <>
                                      <button onClick={() => viewPaymentRow(r)} title="Xem" style={smallBtn('#e0f2fe', '#0284c7')}>👁️</button>
                                      <button onClick={() => editPaymentRow(r)} title="Sửa" style={smallBtn('#fef3c7', '#d97706')}>✏️</button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}

                    {supplierTab === 'returns' && (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                            <th style={{ padding: '8px' }}>Mã phiếu trả</th>
                            <th style={{ padding: '8px', textAlign: 'right' }}>Tiền hàng</th>
                            <th style={{ padding: '8px' }}>Thời gian trả</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>Thao tác</th>
                          </tr>
                        </thead>
                        <tbody>
                          {supplierPrList.length === 0 ? (
                            <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có phiếu trả hàng nhập nào.</td></tr>
                          ) : supplierPrList.map((r) => (
                            <tr key={r.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                              <td onClick={() => viewReturnFromSupplier(r)} style={{ padding: '8px', fontWeight: 'bold', color: '#0284c7', cursor: 'pointer' }} title="Bấm để xem chi tiết">{r.code}</td>
                              <td style={{ padding: '8px', textAlign: 'right', fontWeight: 'bold', color: '#dc2626' }}>{vnd(r.total_amount)}</td>
                              <td style={{ padding: '8px' }}>{r.return_date ? new Date(r.return_date).toLocaleDateString('vi-VN') : '---'}</td>
                              <td style={{ padding: '8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                                <button onClick={() => viewReturnFromSupplier(r)} title="Xem" style={smallBtn('#e0f2fe', '#0284c7')}>👁️</button>
                                <button onClick={() => editReturnFromSupplier(r)} title="Sửa" style={smallBtn('#fef3c7', '#d97706')}>✏️</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              ) : (
                <form onSubmit={handleSaveSupplier} style={{ padding: '20px' }}>
                  <div style={{ marginBottom: '12px' }}><label>Mã NCC (tự sinh nếu trống):</label><input value={supplierForm.code} onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} style={inputStyle} /></div>
                  <div style={{ marginBottom: '12px' }}><label>Tên nhà cung cấp *:</label><input value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} style={inputStyle} required /></div>
                  <div style={{ marginBottom: '12px' }}><label>Số điện thoại:</label><input value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} style={inputStyle} /></div>
                  <div style={{ marginBottom: '15px' }}><label>Địa chỉ:</label><input value={supplierForm.address} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} style={inputStyle} /></div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                    <button type="button" onClick={() => setShowSupplierModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Hủy</button>
                    <button type="submit" style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Lưu nhà cung cấp</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}

        {/* MODAL IMPORT NCC */}
        {showImportModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px' }}>
              <h3 style={{ marginTop: 0 }}>Nhập khẩu danh sách Nhà cung cấp</h3>
              <p style={{ fontSize: '13px', color: '#64748b' }}>Copy từ Excel dán vào theo thứ tự: <code style={{ background: '#f1f5f9', padding: '2px 4px' }}>Mã NCC | Tên NCC | SĐT | Địa chỉ</code></p>
              <textarea rows="8" placeholder={'NCC01\tCông ty A\t0901234567\tQuận 1'} value={importText} onChange={(e) => setImportText(e.target.value)} style={{ width: '100%', padding: '10px', fontFamily: 'monospace', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '15px' }}>
                <button onClick={() => setShowImportModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
                <button
                  onClick={async () => {
                    if (!importText.trim()) {
                      alert('Vui lòng dán dữ liệu vào ô trống!');
                      return;
                    }
                    const rows = importText.split(/\r?\n/).filter(r => r.trim() !== '');
                    const items = rows.map(row => {
                      const cols = row.split(/\t|,/).map(c => c.trim());
                      return {
                        code: cols[0] || '',
                        name: cols[1] || '',
                        phone: cols[2] || '',
                        address: cols.slice(3).join(', ') || '',
                        status: 'active'
                      };
                    }).filter(i => i.name !== '');

                    if (items.length === 0) {
                      alert('Không có dữ liệu hợp lệ!');
                      return;
                    }

                    try {
                      const res = await api('/api/suppliers/import', {
                        method: 'POST',
                        body: JSON.stringify({ items })
                      });

                      if (res && res.success) {
                        alert(`Nhập thành công ${res.successCount || items.length} nhà cung cấp! (Lỗi: ${res.errorCount || 0})`);
                        setShowImportModal(false);
                        setImportText('');
                        loadData();
                      } else {
                        alert('Nhập khẩu không thành công.');
                      }
                    } catch (err) {
                      alert('Lỗi: ' + err.message);
                    }
                  }}
                  style={{ padding: '8px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >Xác nhận</button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL THÊM / SỬA KHÁCH HÀNG */}
        {showCustomerModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '10px', width: '500px' }}>
              <h3 style={{ marginTop: 0 }}>{editingCustomer ? 'Chỉnh sửa khách hàng' : 'Thêm khách hàng mới'}</h3>
              <form onSubmit={handleSaveCustomer}>
                <div style={{ marginBottom: '10px' }}><label>Mã KH (tự sinh nếu trống):</label><input value={customerForm.code} onChange={(e) => setCustomerForm({ ...customerForm, code: e.target.value })} style={inputStyle} /></div>
                <div style={{ marginBottom: '10px' }}><label>Tên khách hàng *:</label><input value={customerForm.name} onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })} style={inputStyle} required /></div>
                <div style={{ marginBottom: '10px' }}><label>Số điện thoại:</label><input value={customerForm.phone} onChange={(e) => setCustomerForm({ ...customerForm, phone: e.target.value })} style={inputStyle} /></div>
                <div style={{ marginBottom: '15px' }}><label>Địa chỉ:</label><input value={customerForm.address} onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })} style={inputStyle} /></div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button type="button" onClick={() => setShowCustomerModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Hủy</button>
                  <button type="submit" style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Lưu</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL IMPORT KHÁCH HÀNG */}
        {showCustomerImportModal && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px' }}>
              <h3 style={{ marginTop: 0 }}>Nhập khẩu danh sách Khách hàng</h3>
              <p style={{ fontSize: '13px', color: '#64748b' }}>Copy từ Excel dán vào theo thứ tự: <code style={{ background: '#f1f5f9', padding: '2px 4px' }}>Mã KH | Tên KH | SĐT | Địa chỉ</code></p>
              <textarea rows="8" placeholder={'KH01\tNguyễn Văn A\t0901234567\tQuận 1'} value={customerImportText} onChange={(e) => setCustomerImportText(e.target.value)} style={{ width: '100%', padding: '10px', fontFamily: 'monospace', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '15px' }}>
                <button onClick={() => setShowCustomerImportModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
                <button
                  onClick={() => runImport({
                    text: customerImportText,
                    endpoint: '/api/customers/import',
                    label: 'khách hàng',
                    close: setShowCustomerImportModal,
                    mapRow: (c) => c.length >= 2 ? { code: c[0], name: c[1], phone: c[2] || '', address: c.slice(3).join(', ') } : null,
                  })}
                  style={{ padding: '8px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >Xác nhận</button>
              </div>
            </div>
          </div>
        )}

        {/* POPUP THỐNG KÊ CHI TIẾT KHÁCH HÀNG (2 TAB) */}
        {showCustomerDetailModal && !customerChildOpen && selectedCustomerDetail && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', width: '900px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#7c3aed' }}>Thống kê khách hàng: {selectedCustomerDetail.name} ({selectedCustomerDetail.code})</h3>
                <button onClick={() => setShowCustomerDetailModal(false)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
              </div>

              <div style={{ display: 'flex', borderBottom: '2px solid #e2e8f0', marginBottom: '20px' }}>
                <button onClick={() => setCustomerDetailTab('orders')} style={tabBtnStyle(customerDetailTab === 'orders')}>📦 Đơn Hàng</button>
                <button onClick={() => setCustomerDetailTab('payments')} style={tabBtnStyle(customerDetailTab === 'payments')}>💰 Lịch Sử Thanh Toán</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px' }}>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#7c3aed' }}>{getCustomerOrderRows().length}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Đơn hàng</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#16a34a' }}>{vnd(selectedCustomerDetail.total_purchased)}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Tổng chi tiêu</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#0284c7' }}>{vnd(customerPaidOf(selectedCustomerDetail))}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Đã thanh toán</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: selectedCustomerDetail.total_debt > 0 ? '#dc2626' : '#16a34a' }}>{vnd(selectedCustomerDetail.total_debt)}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Còn nợ</div>
                </div>
              </div>

              {customerDetailTab === 'orders' && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  <h4>Danh sách đơn hàng</h4>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                        <th style={{ padding: '10px' }}>Mã ĐH</th>
                        <th style={{ padding: '10px' }}>Ngày</th>
                        <th style={{ padding: '10px' }}>Tổng tiền</th>
                        <th style={{ padding: '10px' }}>Đã TT</th>
                        <th style={{ padding: '10px' }}>Còn nợ</th>
                        <th style={{ padding: '10px' }}>Trạng thái</th>
                        <th style={{ padding: '10px', textAlign: 'center' }}>Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {getCustomerOrderRows().length === 0 ? (
                        <tr><td colSpan="7" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có đơn hàng nào.</td></tr>
                      ) : (
                        getCustomerOrderRows().map((inv) => (
                          <tr key={inv.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                            <td onClick={() => viewCustInvoice(inv)} style={{ padding: '10px', fontWeight: 'bold', color: '#0284c7', cursor: 'pointer' }} title="Bấm để xem chi tiết">{inv.code}</td>
                            <td style={{ padding: '10px' }}>{inv.created_at ? new Date(inv.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                            <td style={{ padding: '10px', fontWeight: 'bold' }}>{vnd(inv.total)}</td>
                            <td style={{ padding: '10px', color: '#16a34a' }}>{vnd(inv.paid_amount ?? 0)}</td>
                            <td style={{ padding: '10px', color: '#dc2626' }}>{vnd(inv.debt ?? 0)}</td>
                            <td style={{ padding: '10px' }}>
                              {String(inv.code || '').startsWith('DH')
                                ? <span style={{ padding: '3px 8px', borderRadius: '4px', background: '#fef3c7', color: '#d97706', fontSize: '11px', fontWeight: 'bold' }}>{inv.status || 'Đặt hàng'}</span>
                                : <span style={{ padding: '3px 8px', borderRadius: '4px', background: '#dcfce7', color: '#166534', fontSize: '11px', fontWeight: 'bold' }}>Hoàn thành</span>}
                            </td>
                            <td style={{ padding: '10px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <button onClick={() => viewCustInvoice(inv)} title="Xem" style={smallBtn('#e0f2fe', '#0284c7')}>👁️</button>
                              <button onClick={() => editCustInvoice(inv)} title="Sửa" style={smallBtn('#fef3c7', '#d97706')}>✏️</button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}


              {customerDetailTab === 'payments' && (() => {
                const rows = getCustomerPaymentRows();
                return (
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                    <h4>Lịch sử giao dịch thanh toán</h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                          <th style={{ padding: '10px' }}>Mã</th>
                          <th style={{ padding: '10px' }}>Ngày</th>
                          <th style={{ padding: '10px' }}>Loại</th>
                          <th style={{ padding: '10px', textAlign: 'right' }}>Số tiền</th>
                          <th style={{ padding: '10px' }}>Phương thức</th>
                          <th style={{ padding: '10px' }}>Nội dung</th>
                          <th style={{ padding: '10px', textAlign: 'center' }}>Thao tác</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr><td colSpan="7" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có lịch sử thanh toán nào.</td></tr>
                        ) : rows.map((r) => (
                          <tr key={r.key} style={{ borderBottom: '1px solid #e2e8f0' }}>
                            <td style={{ padding: '10px', fontWeight: 'bold', color: '#7c3aed' }}>{r.code}</td>
                            <td style={{ padding: '10px' }}>{r.date ? new Date(r.date).toLocaleDateString('vi-VN') : '---'}</td>
                            <td style={{ padding: '10px' }}>
                              <span style={{ padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 'bold', background: r.type === 'IN' ? '#dcfce7' : '#fee2e2', color: r.type === 'IN' ? '#16a34a' : '#dc2626' }}>
                                {r.type === 'IN' ? 'Thu tiền khách' : 'Hoàn tiền khách'}
                              </span>
                            </td>
                            <td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold', color: r.type === 'IN' ? '#16a34a' : '#dc2626' }}>{r.type === 'IN' ? '+' : '-'}{vnd(r.amount)}</td>
                            <td style={{ padding: '10px' }}>{r.method || '---'}</td>
                            <td style={{ padding: '10px', color: '#475569' }}>{r.note || '---'}</td>
                            <td style={{ padding: '10px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              {r.kind === 'none' ? '---' : (
                                <>
                                  <button onClick={() => viewCustPaymentRow(r)} title="Xem" style={smallBtn('#e0f2fe', '#0284c7')}>👁️</button>
                                  <button onClick={() => editCustPaymentRow(r)} title="Sửa" style={smallBtn('#fef3c7', '#d97706')}>✏️</button>
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button onClick={() => setShowCustomerDetailModal(false)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
              </div>
            </div>
          </div>
        )}

        {/* POPUP XEM CHI TIẾT GIAO DỊCH THU CHI */}
        {selectedCashItem && (
          <div style={overlayStyle}>
            <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '480px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', borderBottom: '1px solid #e2e8f0', paddingBottom: '10px' }}>
                <h3 style={{ margin: 0, color: '#0f172a' }}>Chi Tiết Giao Dịch</h3>
                <button
                  onClick={() => setSelectedCashItem(null)}
                  style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#64748b' }}
                >
                  ✕
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px', color: '#334155' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Mã Giao Dịch:</span>
                  <strong style={{ color: '#7c3aed' }}>{selectedCashItem.code}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Loại Giao Dịch:</span>
                  <span style={{
                    padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold',
                    background: selectedCashItem.type === 'IN' ? '#dcfce7' : '#fee2e2',
                    color: selectedCashItem.type === 'IN' ? '#16a34a' : '#dc2626'
                  }}>
                    {selectedCashItem.type === 'IN' ? 'Phiếu Thu' : 'Phiếu Chi'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Số Tiền:</span>
                  <strong style={{ fontSize: '16px', color: selectedCashItem.type === 'IN' ? '#16a34a' : '#dc2626' }}>
                    {selectedCashItem.type === 'IN' ? '+' : '-'}{vnd(selectedCashItem.amount)}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Danh Mục:</span>
                  <strong>{selectedCashItem.category}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Phương Thức Thanh Toán:</span>
                  <span>{selectedCashItem.payment_method}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Chứng Từ Liên Quan:</span>
                  <span style={{ color: '#2563eb', fontWeight: '500' }}>{selectedCashItem.reference_code || 'Không có'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Ngày Tạo:</span>
                  <span>{selectedCashItem.created_at}</span>
                </div>
                <div style={{ marginTop: '5px', background: '#f8fafc', padding: '10px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <span style={{ color: '#64748b', display: 'block', marginBottom: '4px', fontSize: '12px' }}>Ghi chú:</span>
                  <span style={{ fontStyle: 'italic', color: '#475569' }}>{selectedCashItem.note || 'Không có ghi chú'}</span>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button
                  onClick={() => setSelectedCashItem(null)}
                  style={{ padding: '8px 20px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  Đóng
                </button>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

// ===== Styles dùng chung =====
const navBtnStyle = (active) => ({ width: '100%', padding: '10px 15px', background: active ? '#0284c7' : 'transparent', color: '#fff', border: 'none', borderRadius: '6px', textAlign: 'left', cursor: 'pointer', fontWeight: active ? 'bold' : 'normal' });
const tabBtnStyle = (active) => ({ flex: 1, padding: '12px', background: active ? '#fff' : 'transparent', border: 'none', borderBottom: active ? '3px solid #0284c7' : 'none', fontWeight: active ? 'bold' : 'normal', color: active ? '#0284c7' : '#64748b', cursor: 'pointer' });
const inputStyle = { width: '100%', padding: '10px', margin: '6px 0', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' };
const cardStyle = { background: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const cellStyle = { padding: '12px' };
const statBoxStyle = { background: '#f8fafc', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0', textAlign: 'center' };
const overlayStyle = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 };
// ===== Cấu hình menu trái theo nhóm =====
const MENU_GROUPS = [
  {
    title: 'Bán hàng',
    items: [
      { view: 'pos', label: '📦 Tạo đơn hàng' },
      { view: 'return-orders', label: '↩️ Trả hàng bán' },
      { view: 'customers', label: '👥 Khách hàng' },
      { view: 'warranties', label: '🛡️ Phiếu bảo hành' },
    ],
  },
  {
    title: 'Kho hàng',
    items: [
      { view: 'products', label: '🏷️ Sản phẩm' },
      { view: 'purchases', label: '📥 Nhập hàng' },
      { view: 'purchase-returns', label: '↩️ Trả hàng nhập' },
      { view: 'suppliers', label: '🚚 Nhà cung cấp' },
    ],
  },
  {
    title: 'Báo cáo',
    items: [
      { view: 'cash-book', label: '💰 Thu chi' },
      { view: 'profit-loss-report', label: '📊 Báo cáo KQ kinh doanh' },
      { view: 'inventory-report', label: '📊 Báo cáo X - N - T' },
    ],
  },
  {
    title: 'Hệ thống',
    items: [
      { view: 'settings', label: '⚙️ Cài đặt doanh nghiệp' },
    ],
  },
];

const menuGroupTitleStyle = { fontSize: '13px', fontWeight: 800, color: '#e2e8f0', margin: '0 0 6px 8px' };
const menuDividerStyle = { border: 0, borderTop: '1px solid #475569', margin: '14px 0' };
const menuBtnStyle = (active) => ({
  width: '100%', padding: '9px 14px', textAlign: 'left',
  background: active ? '#7c3aed' : 'transparent', color: '#fff',
  border: 'none', borderRadius: '8px', cursor: 'pointer',
  fontSize: '14px', fontWeight: active ? 'bold' : 'normal',
  display: 'flex', alignItems: 'center', gap: '10px',
});
// ===== Style gọn riêng cho popup Phiếu nhập (13px, đồng bộ bảng danh mục nhập hàng) =====
const cInput = { width: '100%', height: '30px', padding: '0 8px', margin: 0, fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '5px', boxSizing: 'border-box' };
const cLabel = { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '3px', color: '#374151' };
const cTh = { padding: '6px 8px', fontSize: '12px', whiteSpace: 'nowrap' };
const cTd = { padding: '4px 8px', fontSize: '13px' };
const cCell = { height: '26px', padding: '0 6px', margin: 0, fontSize: '12.5px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' };

