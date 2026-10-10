import { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';
const vnd = (n) => (Number(n) || 0).toLocaleString('vi-VN') + ' ₫';
// Chuyển chuỗi số kiểu "1,500,000" / "1.500.000 ₫" thành số
const num = (s) => Number(String(s ?? '').replace(/[.,\s₫]/g, '')) || 0;
const splitRow = (l) => l.split(/\t|;/).map((x) => x.trim().replace(/^["']|["']$/g, ''));
// Ngày hôm nay theo GIỜ ĐỊA PHƯƠNG (toISOString dùng UTC nên 0h-7h sáng VN sẽ ra ngày hôm qua)
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

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

export default function App() {
  const [currentView, setCurrentView] = useState('pos'); // 'pos' | 'products' | 'suppliers' | 'purchases' | 'customers'

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
  const [productSearchKeyword, setProductSearchKeyword] = useState(''); // dùng cho phiếu nhập
  const [editingOrderId, setEditingOrderId] = useState(null); // Lưu ID đơn đang sửa
  const [editingInvoiceId, setEditingInvoiceId] = useState(null); // Lưu ID phiếu đang sửa (nếu có)

  // ===== States cho Quản lý Sản phẩm =====
  const [showProductModal, setShowProductModal] = useState(false);
  const [showProductImportModal, setShowProductImportModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT);
  const [productImportText, setProductImportText] = useState('');

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
  const [importDate, setImportDate] = useState(() => new Date().toISOString().slice(0, 16));

  const [purchaseForm, setPurchaseForm] = useState({ supplier_id: '', payment_method: 'Tiền mặt', paid_amount: 0 });
  const [purchaseItems, setPurchaseItems] = useState([]);
  const [supplierSearchKeyword, setSupplierSearchKeyword] = useState('');
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);

  const [supplierForm, setSupplierForm] = useState(EMPTY_SUPPLIER);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [supplierTab, setSupplierTab] = useState('info');
  const [supplierHistory, setSupplierHistory] = useState({ purchases: [], payments: [], returns: [] });
  const [editingSupplier, setEditingSupplier] = useState(null);

  const [reportItems, setReportItems] = useState([]);
  const [reportSummary, setReportSummary] = useState({ totalOpeningVal: 0, totalImportVal: 0, totalExportVal: 0, totalClosingVal: 0 });
  const [reportSearch, setReportSearch] = useState('');

  const loadInventoryReport = async () => {
    try {
      const res = await api(`/api/reports/inventory-summary?search=${encodeURIComponent(reportSearch)}`);
      if (res && res.success) {
        setReportItems(res.items || []);
        setReportSummary(res.summary || {});
      }
    } catch (e) {
      console.error('Lỗi tải báo cáo:', e);
    }
  };

  // Gọi tự động khi chuyển sang view báo cáo
  useEffect(() => {
    if (currentView === 'inventory-report') {
      loadInventoryReport();
    }
  }, [currentView]);

  // Quản lý thông tin doanh nghiệp & Logo (tự động lưu vào localStorage)
  const [companyInfo, setCompanyInfo] = useState(() => {
    const saved = localStorage.getItem('company_info');
    return saved ? JSON.parse(saved) : {
      name: 'XE ĐIỆN LINH KHANG (LK EBIKE)',
      brand: 'LK EBIKE',
      subtitle: 'By BabyBikeStore',
      address: '767/10 Trần Hưng Đạo, Phường Chợ Quán, Tp.HCM',
      taxCode: '07918402804',
      phone: '0768 640 918',
      logoUrl: '' // Dán link ảnh logo vào đây hoặc để trống sẽ hiện chữ Brand
    };
  });

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
  const [showCustomerDetailModal, setShowCustomerDetailModal] = useState(false);

  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const asArray = (d) => (Array.isArray(d) ? d : []);

  const loadData = () => {
    api('/api/products').then((d) => setProducts(asArray(d))).catch((e) => setMsg({ type: 'err', text: e.message }));
    api('/api/suppliers').then((d) => setSuppliers(asArray(d))).catch(() => {});
    api('/api/purchase_orders').then((d) => setPurchaseOrders(asArray(d))).catch(() => {});
    api('/api/customers').then((d) => setCustomers(asArray(d))).catch(() => {});
    api('/api/invoices').then((d) => setInvoicesList(asArray(d))).catch(() => {});
    api('/api/orders').then((d) => setOrdersList(asArray(d))).catch(() => {});
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

      // Đưa sản phẩm vào giỏ hàng
      const newCart = {};
      details.items.forEach(item => {
        newCart[item.product_id] = item.quantity;
        newCart[item.product_id + '_price'] = item.price;
        newCart[item.product_id + '_discount'] = item.discount || 0;
      });
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
        items: cartLines.map((l) => ({ product_id: l.id, quantity: l.quantity, price: l.price, discount: l.discount }))
      };

      let r;
      if (modalOrderType === 'orders' && editingOrderId) {
        // Nếu đang sửa đơn đặt hàng
        r = await api(`/api/orders/${editingOrderId}`, { method: 'PUT', body: JSON.stringify(body) });
        setMsg({ type: 'ok', text: `Đã cập nhật đơn đặt hàng ${r.code || ''} thành công!` });
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
        setMsg({ type: 'ok', text: `Tạo ${modalOrderType === 'invoices' ? 'phiếu bán hàng' : 'đơn đặt hàng'} ${r.code} thành công!` });
      }

      setCart({});
      setPosCustomer({ name: '', phone: '', address: '' });
      setCustomerSearch('');
      setPaidAmount(0);
      setEditingOrderId(null);
      setShowOrderModal(false);
      loadData();
    } catch (e) {
      alert('Lỗi: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

    // === CHÈN ĐOẠN HÀM handlePrintOrder VÀO ĐÂY ===
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
    const paymentMethod = printData.payment_method || 'Tiền mặt';
    
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

      return `
        <tr>
          <td style="text-align: center; padding: 8px; border-bottom: 1px solid #e2e8f0;">${index + 1}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${prod.product_name || prod.name || 'Sản phẩm'}</td>
          <td style="text-align: center; padding: 8px; border-bottom: 1px solid #e2e8f0;">${qty}</td>
          <td style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0;">${price.toLocaleString('vi-VN')}</td>
          <td style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0; color: #dc2626;">${discount > 0 ? discount.toLocaleString('vi-VN') : '0'}</td>
          <td style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${lineNet.toLocaleString('vi-VN')}</td>
        </tr>
      `;
    }).join('');

    const finalTotal = grossTotal - totalDiscount;
    const paidAmount = Number(printData.paid_amount) || 0;
    const debtAmount = finalTotal - paidAmount;

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
              <p><b>Hình thức TT:</b> ${paymentMethod}</p>
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
            <div><span>Đã thanh toán / Tạm ứng:</span> <b>${paidAmount.toLocaleString('vi-VN')} ₫</b></div>
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
            window.onload = function() { window.print(); window.close(); };
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
      setEditingOrderId(ord.id); // Lưu lại ID để biết đang sửa đơn này
      setModalOrderType('orders');
      setPosCustomer({ name: details.customer_name, phone: details.customer_phone || '', address: details.address || '' });
      setCustomerSearch(details.customer_name);
      setPaidAmount(details.paid_amount || 0);
      setPaymentMethod(details.payment_method || 'Tiền mặt');
      setOrderDate(details.created_at ? details.created_at.split('T')[0] : new Date().toISOString().split('T')[0]);

      const newCart = {};
      details.items.forEach(item => {
        newCart[item.product_id] = item.quantity;
        newCart[item.product_id + '_price'] = item.price;
        newCart[item.product_id + '_discount'] = item.discount || 0;
      });
      setCart(newCart);
      setShowOrderModal(true);
    } catch (e) {
      alert('Lỗi khi tải dữ liệu sửa đơn: ' + e.message);
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
    try {
      const hist = await api(`/api/suppliers/${s.id}/history`);
      setSupplierHistory(hist);
    } catch (e) {
      setSupplierHistory({ purchases: [], payments: [], returns: [] });
    }
    setShowSupplierModal(true);
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
    try {
      const data = await api(`/api/customers/${c.id}/history`);
      setCustomerDetailData({ invoices: data.invoices || [], payments: data.payments || [] });
    } catch (e) {
      setCustomerDetailData({ invoices: [], payments: [] });
    }
    setShowCustomerDetailModal(true);
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
      created_at: new Date().toISOString().slice(0, 16) // 👈 Khởi tạo ngày giờ hiện tại
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
          created_at: purchaseForm.created_at ? new Date(purchaseForm.created_at).toISOString() : new Date().toISOString(), // 👈 Thêm trường này để tùy chỉnh ngày nhập
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

    // 🔹 ĐẶT CÁC STATE VÀ HÀM NÀY BÊN TRONG COMPONENT `App`
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

  const filteredPosProducts = (products || []).filter((p) =>
    p.name.toLowerCase().includes(posProductKeyword.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(posProductKeyword.toLowerCase()))
  );

  const filteredPosCustomers = (customers || []).filter((c) =>
    c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
    (c.phone && c.phone.includes(customerSearch)) ||
    (c.code || '').toLowerCase().includes(customerSearch.toLowerCase())
  );

  return (
    <div className="layout" style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>
      {/* Thanh menu bên trái */}
      <aside className="sidebar" style={{ width: '260px', background: '#1e293b', color: '#fff', padding: '20px' }}>
        <h2 style={{ fontSize: '1.2rem', marginBottom: '20px', color: '#38bdf8' }}>LK Ebike POS</h2>
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <li><button onClick={() => setCurrentView('pos')} style={navBtnStyle(currentView === 'pos')}>Tạo đơn hàng</button></li>
          <li><button onClick={() => setCurrentView('products')} style={navBtnStyle(currentView === 'products')}>Sản phẩm</button></li>
          <li><button onClick={() => setCurrentView('suppliers')} style={navBtnStyle(currentView === 'suppliers')}>Nhà cung cấp</button></li>
          <li><button onClick={() => setCurrentView('purchases')} style={navBtnStyle(currentView === 'purchases')}>Nhập hàng</button></li>
          <li><button onClick={() => setCurrentView('customers')} style={navBtnStyle(currentView === 'customers')}>Khách hàng</button></li>
          <button 
          onClick={() => setCurrentView('settings')} 
          style={{ 
            width: '100%', textAlign: 'left', padding: '12px 16px', background: currentView === 'settings' ? '#7c3aed' : 'transparent', 
            color: '#fff', /* 👈 Đảm bảo luôn là màu trắng (#fff) */
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginBottom: '5px', display: 'flex', alignItems: 'center', gap: '10px' 
          }}
        >
          ⚙️ Cài đặt Doanh Nghiệp
        </button>
           <button 
          onClick={() => setCurrentView('inventory-report')} 
          style={{ 
            width: '100%', textAlign: 'left', padding: '12px 16px', background: currentView === 'inventory-report' ? '#7c3aed' : 'transparent', 
            color: '#fff', /* 👈 Đảm bảo luôn là màu trắng (#fff) */
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginBottom: '5px', display: 'flex', alignItems: 'center', gap: '10px' 
          }}
        >
          📊 Báo Cáo X - N - T
        </button>
        </ul>
      </aside>

      {/* Nội dung chính bên phải */}
      <main className="main-content" style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {msg && <div style={{ padding: '10px', marginBottom: '15px', borderRadius: '6px', background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#166534' : '#991b1b' }}>{msg.text}</div>}

        {/* 1. MÀN HÌNH DANH SÁCH ĐƠN HÀNG & PHIẾU BÁN HÀNG */}
        {currentView === 'pos' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Đơn hàng & Phiếu bán hàng</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button 
                onClick={() => { setEditingOrderId(null); setModalOrderType('invoices'); setCart({}); setPosCustomer({ name: '', phone: '', address: '' }); setCustomerSearch(''); setPaidAmount(0); setShowOrderModal(true); }}
                style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                + Tạo Phiếu Bán Hàng
              </button>
              <button 
                onClick={() => { setEditingOrderId(null); setModalOrderType('orders'); setCart({}); setPosCustomer({ name: '', phone: '', address: '' }); setCustomerSearch(''); setPaidAmount(0); setShowOrderModal(true); }}
                style={{ padding: '10px 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                + Tạo Đơn Đặt Hàng
              </button>
            </div>
            </div>

            {/* Bảng Danh sách Phiếu Bán Hàng */}
            <div style={{ background: '#fff', padding: '20px', borderRadius: '8px', marginBottom: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, color: '#16a34a' }}>📦 Danh sách Phiếu Bán Hàng ({invoicesList.length})</h3>
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
                  </tr>
                </thead>
                <tbody>
                  {invoicesList.length === 0 ? (
                    <tr><td colSpan="7" style={{ textAlign: 'center', padding: '15px', color: '#94a3b8' }}>Chưa có phiếu bán hàng nào.</td></tr>
                  ) : (
                    invoicesList.map((inv) => (
                      <tr key={inv.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '10px', fontWeight: 'bold', color: '#0284c7' }}>{inv.code}</td>
                        <td style={{ padding: '10px' }}>{inv.created_at ? new Date(inv.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                        <td style={{ padding: '10px', fontWeight: '500' }}>{inv.customer_name}</td>
                        <td style={{ padding: '10px', fontWeight: 'bold' }}>{vnd(inv.total)}</td>
                        <td style={{ padding: '10px', color: '#16a34a' }}>{vnd(inv.paid_amount)}</td>
                        <td style={{ padding: '10px', color: inv.debt > 0 ? '#dc2626' : '#16a34a' }}>{vnd(inv.debt)}</td>
                        <td style={{ padding: '10px' }}>{inv.payment_method || 'Tiền mặt'}</td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <button onClick={() => handlePrintOrder(inv, false)} title="In phiếu bán hàng" style={{ background: '#e0f2fe', color: '#0284c7', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>🖨️</button>
                          <button onClick={() => handleViewDetail('invoices', inv.id)} title="Xem chi tiết" style={{ background: '#f1f5f9', color: '#475569', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>👁️</button>
                          <button onClick={() => handleDeleteOrderOrInvoice('invoices', inv.id, inv.code)} title="Xóa" style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer' }}>🗑️</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Bảng Danh sách Đơn Đặt Hàng */}
            <div style={{ background: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, color: '#7c3aed' }}>📝 Danh sách Đơn Đặt Hàng ({ordersList.length})</h3>
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
                  {ordersList.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '15px', color: '#94a3b8' }}>Chưa có đơn đặt hàng nào.</td></tr>
                  ) : (
                    ordersList.map(ord => (
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
                      <td style={{ padding: '8px' }}>{item.product_name}</td>
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
                onClick={() => handlePrintOrder(detailData, detailData.code.startsWith('DH'))} 
                style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                🖨️ In Chứng Từ
              </button>
              <button onClick={() => setShowDetailModal(false)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
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
                  {(products || []).map((p) => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={cellStyle}>{p.sku}</td>
                      <td style={{ ...cellStyle, fontWeight: 'bold', color: '#0284c7' }}>{p.name}</td>
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

        {/* 3. MÀN HÌNH QUẢN LÝ NHÀ CUNG CẤP */}
        {currentView === 'suppliers' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Nhà cung cấp</h2>
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

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={cellStyle}>Mã NCC</th>
                  <th style={cellStyle}>Tên NCC</th>
                  <th style={cellStyle}>SĐT</th>
                  <th style={cellStyle}>Địa chỉ</th>
                  <th style={cellStyle}>Tổng giá trị nhập</th>
                  <th style={cellStyle}>Đã thanh toán</th>
                  <th style={cellStyle}>Công nợ</th>
                  <th style={cellStyle}>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {(suppliers || []).map((s) => (
                  <tr key={s.id} onClick={() => openSupplierDetail(s)} style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}>
                    <td style={cellStyle}>{s.code}</td>
                    <td style={{ ...cellStyle, fontWeight: 'bold', color: '#0284c7' }}>{s.name}</td>
                    <td style={cellStyle}>{s.phone || '-'}</td>
                    <td style={cellStyle}>{s.address || '-'}</td>
                    <td style={cellStyle}>{vnd(s.total_purchase)}</td>
                    <td style={{ ...cellStyle, color: '#16a34a' }}>{vnd(s.total_paid)}</td>
                    <td style={{ ...cellStyle, color: s.total_debt > 0 ? '#dc2626' : 'inherit', fontWeight: s.total_debt > 0 ? 'bold' : 'normal' }}>{vnd(s.total_debt)}</td>
                    <td style={cellStyle}>{s.status === 'active' ? 'Hoạt động' : 'Ngừng'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 4. MÀN HÌNH QUẢN LÝ NHẬP HÀNG */}
        {currentView === 'purchases' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Nhập Hàng</h2>
              <button
                onClick={openCreatePurchase}
                style={{ padding: '10px 20px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                + Tạo Phiếu Nhập
              </button>
            </div>

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
                {purchaseOrders.length === 0 ? (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có phiếu nhập hàng nào.</td></tr>
                ) : (
                  purchaseOrders.map((po) => {
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

            {/* Các Thẻ Tổng Quan Phía Trên */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px' }}>
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

            {/* Thanh Bộ Lọc */}
            <div style={{ background: '#fff', padding: '15px', borderRadius: '10px', display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <input 
                placeholder="🔍 Tìm mã hoặc tên sản phẩm..." 
                value={reportSearch} 
                onChange={(e) => setReportSearch(e.target.value)} 
                style={{ flex: 1, padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
              />
              <button onClick={loadInventoryReport} style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Lọc dữ liệu</button>
            </div>

            {/* Bảng Chi Tiết Xuất Nhập Tồn (Đã bỏ cột Đơn giá BQ theo yêu cầu) */}
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
                  {reportItems.map((item) => (
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
                  ))}
                </tbody>
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

        {/* 5. MÀN HÌNH QUẢN LÝ KHÁCH HÀNG */}
        {currentView === 'customers' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Khách hàng ({customers.length})</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => { setCustomerImportText(''); setShowCustomerImportModal(true); }} style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>📁 Nhập Excel / Dán dữ liệu</button>
                <button onClick={() => { setEditingCustomer(null); setCustomerForm(EMPTY_CUSTOMER); setShowCustomerModal(true); }} style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>+ Thêm khách hàng</button>
              </div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={cellStyle}>Mã KH</th>
                  <th style={cellStyle}>Tên khách hàng</th>
                  <th style={cellStyle}>Số điện thoại</th>
                  <th style={cellStyle}>Địa chỉ</th>
                  <th style={cellStyle}>Tổng mua</th>
                  <th style={cellStyle}>Đã thanh toán</th>
                  <th style={cellStyle}>Công nợ</th>
                  <th style={{ ...cellStyle, textAlign: 'center' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {customers.length === 0 ? (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có khách hàng nào.</td></tr>
                ) : (
                  customers.map((c) => (
                    <tr key={c.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={cellStyle}>{c.code}</td>
                      <td style={{ ...cellStyle, fontWeight: 'bold', color: '#0284c7', cursor: 'pointer' }} onClick={() => openCustomerDetail(c)}>{c.name}</td>
                      <td style={cellStyle}>{c.phone || '-'}</td>
                      <td style={cellStyle}>{c.address || '-'}</td>
                      <td style={cellStyle}>{vnd(c.total_purchased)}</td>
                      <td style={{ ...cellStyle, color: '#16a34a' }}>{vnd(c.total_paid)}</td>
                      <td style={{ ...cellStyle, color: c.total_debt > 0 ? '#dc2626' : '#16a34a', fontWeight: c.total_debt > 0 ? 'bold' : 'normal' }}>{vnd(c.total_debt)}</td>
                      <td style={{ ...cellStyle, textAlign: 'center' }}>
                        <button onClick={() => { setEditingCustomer(c); setCustomerForm({ code: c.code, name: c.name, phone: c.phone || '', address: c.address || '' }); setShowCustomerModal(true); }} title="Sửa" style={{ background: '#fef3c7', color: '#d97706', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '6px' }}>✏️</button>
                        <button onClick={() => handleDeleteCustomer(c.id, c.name)} title="Xóa" style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer' }}>🗑️</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

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

      {/* POPUP TẠO / SỬA PHIẾU NHẬP HÀNG */}
      {showCreatePurchaseModal && (
        <div style={overlayStyle}>
          <div style={{ background: '#fff', width: '900px', maxHeight: '90vh', borderRadius: '12px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <div style={{ padding: '20px', background: '#7c3aed', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>{editingPurchaseId ? 'Chỉnh sửa Phiếu Nhập Hàng' : 'Tạo Phiếu Nhập Hàng'}</h3>
              <button onClick={() => setShowCreatePurchaseModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px', marginBottom: '20px', padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ position: 'relative' }}>
                  <label style={labelStyle}>Nhà cung cấp *:</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      placeholder="Nhập tên, SĐT hoặc mã NCC..."
                      value={supplierSearchKeyword}
                      onChange={(e) => {
                        setSupplierSearchKeyword(e.target.value);
                        setPurchaseForm((f) => ({ ...f, supplier_id: '' })); // gõ lại thì bỏ NCC đã chọn trước đó
                        setShowSupplierDropdown(true);
                      }}
                      onFocus={() => setShowSupplierDropdown(true)}
                      onBlur={() => setTimeout(() => setShowSupplierDropdown(false), 150)}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowQuickAddSupplierModal(true)}
                      title="Thêm nhà cung cấp mới"
                      style={{ background: '#7c3aed', color: '#fff', border: 'none', padding: '0 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                    >
                      + Thêm
                    </button>
                  </div>

                  {/* 🔹 ĐẶT HOẶC CHÈN ĐOẠN POPUP NÀY Ở KHU VỰC CÁC MODAL CỦA ỨNG DỤNG */}
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
                          style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                        >
                          <b>{s.name}</b> <span style={{ color: '#64748b' }}>({s.code})</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label style={labelStyle}>Phương thức thanh toán:</label>
                  <select
                    value={purchaseForm.payment_method}
                    onChange={(e) => setPurchaseForm({ ...purchaseForm, payment_method: e.target.value })}
                    style={inputStyle}
                  >
                    <option value="Tiền mặt">Tiền mặt</option>
                    <option value="Chuyển khoản">Chuyển khoản</option>
                    <option value="Công nợ">Công nợ</option>
                  </select>
                </div>
                
                <div>
  <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Ngày nhập hàng:</label>
  <input 
    type="datetime-local" 
    value={purchaseForm.created_at || ''} 
    onChange={(e) => setPurchaseForm({ ...purchaseForm, created_at: e.target.value })} 
    style={inputStyle} 
  />
</div>
            </div>

              <div style={{ marginBottom: '20px' }}>
                <label style={labelStyle}>Tìm kiếm sản phẩm để thêm vào phiếu nhập:</label>
                <input
                  placeholder="Nhập tên sản phẩm hoặc mã SKU..."
                  value={productSearchKeyword}
                  onChange={(e) => setProductSearchKeyword(e.target.value)}
                  style={inputStyle}
                />
                {productSearchKeyword.trim() && (
                  <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '150px', overflowY: 'auto', marginTop: '5px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
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
                        style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f1f5f9' }}
                      >
                        <span><b>{p.name}</b> (SKU: {p.sku})</span>
                        <span style={{ color: '#0284c7', fontWeight: 'bold' }}>+ Thêm</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: '20px', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                      <th style={{ padding: '10px' }}>SKU</th>
                      <th style={{ padding: '10px' }}>Tên sản phẩm</th>
                      <th style={{ padding: '10px' }}>ĐVT</th>
                      <th style={{ padding: '10px', width: '80px' }}>SL</th>
                      <th style={{ padding: '10px', width: '130px' }}>Đơn giá</th>
                      <th style={{ padding: '10px', width: '100px' }}>Giảm</th>
                      <th style={{ padding: '10px' }}>Thành tiền</th>
                      <th style={{ padding: '10px', width: '50px' }}>Xóa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseItems.length === 0 ? (
                      <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có sản phẩm nào trong phiếu nhập.</td></tr>
                    ) : (
                      purchaseItems.map((item, index) => {
                        const lineTotal = (item.quantity * item.price) - item.discount;
                        return (
                          <tr key={item.product_id ?? index} style={{ borderBottom: '1px solid #e2e8f0' }}>
                            <td style={{ padding: '10px' }}>{item.sku}</td>
                            <td style={{ padding: '10px', fontWeight: '500' }}>{item.name}</td>
                            <td style={{ padding: '10px' }}>{item.unit}</td>
                            <td style={{ padding: '10px' }}>
                              <input type="number" min="1" value={item.quantity} onChange={(e) => updatePurchaseItem(index, { quantity: Math.max(1, Number(e.target.value) || 1) })} style={{ width: '60px', padding: '6px', textAlign: 'center' }} />
                            </td>
                            <td style={{ padding: '10px' }}>
                              <input type="number" value={item.price} onChange={(e) => updatePurchaseItem(index, { price: Number(e.target.value) || 0 })} style={{ width: '110px', padding: '6px' }} />
                            </td>
                            <td style={{ padding: '10px' }}>
                              <input type="number" value={item.discount} onChange={(e) => updatePurchaseItem(index, { discount: Number(e.target.value) || 0 })} style={{ width: '90px', padding: '6px' }} />
                            </td>
                            <td style={{ padding: '10px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(lineTotal)}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={() => setPurchaseItems(purchaseItems.filter((_, idx) => idx !== index))} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {(() => {
                const totalAmount = purchaseItems.reduce((sum, item) => sum + ((item.quantity * item.price) - item.discount), 0);
                const debtAmount = totalAmount - (Number(purchaseForm.paid_amount) || 0);

                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: '15px 20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                      <div><span style={{ color: '#64748b' }}>Tổng: </span><b>{vnd(totalAmount)}</b></div>
                      <div>
                        <span style={{ color: '#64748b' }}>Đã trả: </span>
                        <input type="number" value={purchaseForm.paid_amount} onChange={(e) => setPurchaseForm({ ...purchaseForm, paid_amount: e.target.value })} style={{ width: '110px', padding: '6px', fontWeight: 'bold' }} />
                      </div>
                      <div><span style={{ color: '#64748b' }}>Nợ: </span><b style={{ color: debtAmount > 0 ? '#dc2626' : '#16a34a' }}>{vnd(Math.max(0, debtAmount))}</b></div>
                    </div>

                    <button
                      onClick={handleSavePurchase}
                      style={{ padding: '10px 20px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
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

      {/* POPUP TẠO PHIẾU BÁN HÀNG / ĐƠN ĐẶT HÀNG (zIndex 900 để các popup thêm SP/KH hiện lên trên) */}
      {showOrderModal && (
        <div style={{ ...overlayStyle, zIndex: 900 }}>
          <div style={{ background: '#fff', width: '950px', maxHeight: '90vh', borderRadius: '12px', padding: '25px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h3 style={{ margin: 0, color: modalOrderType === 'invoices' ? '#16a34a' : '#7c3aed' }}>
                {modalOrderType === 'invoices' ? '📦 Tạo Phiếu Bán Hàng (trừ tồn kho)' : '📝 Tạo Đơn Đặt Hàng (không trừ kho)'}
              </h3>
              <button onClick={() => setShowOrderModal(false)} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px', flex: 1, overflowY: 'auto' }}>
              {/* ===== Cột trái: chọn sản phẩm ===== */}
              <div>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                  <input
                    placeholder="Gõ mã hoặc tên sản phẩm..."
                    value={posProductKeyword}
                    onChange={(e) => setPosProductKeyword(e.target.value)}
                    style={{ ...inputStyle, margin: 0 }}
                  />
                  <button
                    onClick={() => { setEditingProduct(null); setProductForm(EMPTY_PRODUCT); setShowProductModal(true); }}
                    title="Thêm sản phẩm mới"
                    style={{ padding: '0 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                  >+</button>
                </div>
                <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
                  {filteredPosProducts.map((p) => {
                    const isOutOfStock = p.stock <= 0;
                    return (
                      <div
                        key={p.id}
                        onClick={() => add(p)}
                        style={{ padding: '12px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: isOutOfStock ? '#fffbeb' : '#fff' }}
                      >
                        <div>
                          <strong style={{ color: '#0f172a' }}>{p.sku ? `${p.sku} - ` : ''}{p.name}</strong><br />
                          <small style={{ color: isOutOfStock ? '#dc2626' : '#64748b' }}>
                            {isOutOfStock ? (modalOrderType === 'invoices' ? 'Hết hàng' : 'Hết (Cho phép đặt)') : `Tồn: ${p.stock}`} | ĐVT: {p.unit || 'Cái'}
                          </small>
                        </div>
                        <div style={{ textAlign: 'right', fontWeight: 'bold', color: '#7c3aed' }}>{vnd(p.price)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ===== Cột phải: thông tin đơn + giỏ hàng ===== */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>

                {modalOrderType === 'invoices' && (
                  <div style={{ marginBottom: '10px', background: '#f0fdf4', padding: '10px', borderRadius: '6px', border: '1px solid #bbf7d0' }}>
                    <label style={{ fontSize: '12px', fontWeight: 'bold', color: '#16a34a' }}>Chọn từ Đơn Đặt Hàng trước đó (nếu có):</label>
                    <select 
                      onChange={(e) => handleSelectOrderToInvoice(e.target.value)}
                      style={{ ...inputStyle, margin: '4px 0 0 0' }}
                    >
                      <option value="">-- Chọn đơn đặt hàng để xuất bán --</option>
                      {ordersList.map(o => (
                        <option key={o.id} value={o.id}>{o.code} - {o.customer_name} ({vnd(o.total)})</option>
                      ))}
                    </select>
                  </div>
                )}
                
                <div style={{ marginBottom: '15px' }}>
                  <label style={labelStyle}>Ngày tạo:</label>
                  <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} style={inputStyle} />
                </div>

                <div style={{ marginBottom: '15px', position: 'relative' }}>
                  <label style={labelStyle}>Khách hàng:</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
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
                      style={{ ...inputStyle, margin: 0, flex: 1 }}
                    />
                    <button
                      onClick={() => { setEditingCustomer(null); setCustomerForm({ ...EMPTY_CUSTOMER, name: customerSearch }); setShowCustomerModal(true); }}
                      title="Thêm khách hàng mới"
                      style={{ padding: '0 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '18px' }}
                    >+</button>
                  </div>
                  {showCustomerDropdown && filteredPosCustomers.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 45, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '160px', overflowY: 'auto', zIndex: 20, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                      {filteredPosCustomers.map((c) => (
                        <div
                          key={c.id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setPosCustomer({ name: c.name, phone: c.phone || '', address: c.address || '' });
                            setCustomerSearch(c.name);
                            setShowCustomerDropdown(false);
                          }}
                          style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                        >
                          <b>{c.name}</b> - <span style={{ color: '#64748b' }}>{c.phone || 'Chưa có SĐT'} ({c.code})</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                  <div>
                    <label style={labelStyle}>Số điện thoại:</label>
                    <input value={posCustomer.phone} onChange={(e) => setPosCustomer({ ...posCustomer, phone: e.target.value })} placeholder="SĐT khách hàng..." style={{ ...inputStyle, margin: 0 }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Địa chỉ:</label>
                    <input value={posCustomer.address} onChange={(e) => setPosCustomer({ ...posCustomer, address: e.target.value })} placeholder="Địa chỉ khách hàng..." style={{ ...inputStyle, margin: 0 }} />
                  </div>
                </div>

                <h4 style={{ margin: '10px 0 5px 0' }}>Chi tiết đơn hàng</h4>
                <div style={{ flex: 1, minHeight: '140px', maxHeight: '200px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '6px', marginBottom: '15px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', textAlign: 'left', fontSize: '13px' }}>
                        <th style={{ padding: '10px' }}>Sản phẩm</th>
                        <th style={{ padding: '10px', width: '70px' }}>SL</th>
                        <th style={{ padding: '10px' }}>Đơn giá</th>
                        <th style={{ padding: '10px', width: '90px' }}>Giảm giá</th>
                        <th style={{ padding: '10px' }}>Thành tiền</th>
                        <th style={{ padding: '10px', width: '40px' }}>Xóa</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cartLines.length === 0 ? (
                        <tr><td colSpan="6" style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>Chưa có sản phẩm nào</td></tr>
                      ) : (
                        cartLines.map((l) => (
                          <tr key={l.id} style={{ borderBottom: '1px solid #e2e8f0', fontSize: '13px' }}>
                            <td style={{ padding: '10px', fontWeight: '500' }}>{l.name}</td>
                            <td style={{ padding: '10px' }}>
                              <input type="number" min="1" value={l.quantity} onChange={(e) => setQty(l.id, Math.max(1, Number(e.target.value) || 1))} style={{ width: '50px', textAlign: 'center', padding: '4px' }} />
                            </td>
                            <td style={{ padding: '10px' }}>
                              <input type="number" value={l.price} onChange={(e) => setItemPrice(l.id, e.target.value)} style={{ width: '90px', padding: '4px', fontWeight: 'bold', color: '#7c3aed' }} />
                            </td>
                            <td style={{ padding: '10px' }}>
                              <input type="number" value={l.discount} onChange={(e) => setDiscount(l.id, e.target.value)} style={{ width: '70px', padding: '4px' }} />
                            </td>
                            <td style={{ padding: '10px', fontWeight: 'bold', color: '#16a34a' }}>{vnd((l.price * l.quantity) - l.discount)}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={() => setQty(l.id, 0)} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div style={{ background: '#f8fafc', padding: '15px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '15px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '10px' }}>
                    <span>TỔNG CỘNG:</span>
                    <span style={{ color: '#7c3aed' }}>{vnd(cartTotal)}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', alignItems: 'start' }}>
                    <div>
                      <label style={{ fontSize: '12px', color: '#64748b' }}>Khách đã thanh toán:</label>
                      <input type="number" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} style={{ ...inputStyle, margin: '2px 0 0 0', fontWeight: 'bold' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: '#64748b' }}>Còn nợ đơn này:</label>
                      <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: cartDebt > 0 ? '#dc2626' : '#16a34a', marginTop: '10px' }}>{vnd(cartDebt)}</div>
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: '#64748b' }}>Phương thức TT:</label>
                      <select
                        value={paymentMethod}
                        onChange={(e) => { setPaymentMethod(e.target.value); if (e.target.value === 'Công nợ') setPaidAmount(0); }}
                        style={{ ...inputStyle, margin: '2px 0 0 0' }}
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
                  style={{ width: '100%', padding: '14px', background: modalOrderType === 'invoices' ? '#16a34a' : '#7c3aed', color: '#fff', border: 'none', borderRadius: '8px', cursor: busy || cartLines.length === 0 ? 'not-allowed' : 'pointer', opacity: busy || cartLines.length === 0 ? 0.6 : 1, fontWeight: 'bold', fontSize: '16px' }}
                >
                  {modalOrderType === 'invoices' ? 'XÁC NHẬN TẠO PHIẾU BÁN HÀNG' : 'XÁC NHẬN TẠO ĐƠN ĐẶT HÀNG'}
                </button>
              </div>
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
      {showSupplierModal && (
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
                      <thead><tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Mã phiếu</th><th style={{ padding: '8px' }}>Tổng tiền</th><th style={{ padding: '8px' }}>Ngày tạo</th></tr></thead>
                      <tbody>{(supplierHistory.purchases || []).map((p) => (<tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px' }}>{p.code}</td><td style={{ padding: '8px' }}>{vnd(p.total)}</td><td style={{ padding: '8px' }}>{p.created_at}</td></tr>))}</tbody>
                    </table>
                  )}

                  {supplierTab === 'payments' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Số tiền</th><th style={{ padding: '8px' }}>Ghi chú</th><th style={{ padding: '8px' }}>Thời gian</th></tr></thead>
                      <tbody>{(supplierHistory.payments || []).map((pay) => (<tr key={pay.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px', color: '#16a34a' }}>{vnd(pay.amount)}</td><td style={{ padding: '8px' }}>{pay.note || '---'}</td><td style={{ padding: '8px' }}>{pay.created_at}</td></tr>))}</tbody>
                    </table>
                  )}

                  {supplierTab === 'returns' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Tổng trả</th><th style={{ padding: '8px' }}>Ghi chú</th><th style={{ padding: '8px' }}>Thời gian</th></tr></thead>
                      <tbody>{(supplierHistory.returns || []).map((ret) => (<tr key={ret.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px', color: '#dc2626' }}>{vnd(ret.total)}</td><td style={{ padding: '8px' }}>{ret.note || '---'}</td><td style={{ padding: '8px' }}>{ret.created_at}</td></tr>))}</tbody>
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
                onClick={() => runImport({
                  text: importText,
                  endpoint: '/api/suppliers/import',
                  label: 'nhà cung cấp',
                  close: setShowImportModal,
                  mapRow: (c) => c.length >= 2 ? { code: c[0], name: c[1], phone: c[2] || '', address: c.slice(3).join(', ') } : null,
                })}
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
      {showCustomerDetailModal && selectedCustomerDetail && (
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
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#7c3aed' }}>{customerDetailData.invoices.length}</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>Đơn hàng</div>
              </div>
              <div style={statBoxStyle}>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#16a34a' }}>{vnd(selectedCustomerDetail.total_purchased)}</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>Tổng chi tiêu</div>
              </div>
              <div style={statBoxStyle}>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#0284c7' }}>{vnd(selectedCustomerDetail.total_paid)}</div>
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
                    </tr>
                  </thead>
                  <tbody>
                    {customerDetailData.invoices.length === 0 ? (
                      <tr><td colSpan="6" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có đơn hàng nào.</td></tr>
                    ) : (
                      customerDetailData.invoices.map((inv) => (
                        <tr key={inv.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '10px', fontWeight: 'bold', color: '#0284c7' }}>{inv.code}</td>
                          <td style={{ padding: '10px' }}>{inv.created_at ? new Date(inv.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                          <td style={{ padding: '10px', fontWeight: 'bold' }}>{vnd(inv.total)}</td>
                          <td style={{ padding: '10px', color: '#16a34a' }}>{vnd(inv.paid_amount ?? 0)}</td>
                          <td style={{ padding: '10px', color: '#dc2626' }}>{vnd(inv.debt ?? 0)}</td>
                          <td style={{ padding: '10px' }}><span style={{ padding: '3px 8px', borderRadius: '4px', background: '#dcfce7', color: '#166534', fontSize: '11px', fontWeight: 'bold' }}>Hoàn thành</span></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {customerDetailTab === 'payments' && (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <h4>Lịch sử giao dịch thanh toán</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                      <th style={{ padding: '10px' }}>Mã GD</th>
                      <th style={{ padding: '10px' }}>Ngày</th>
                      <th style={{ padding: '10px' }}>Số tiền</th>
                      <th style={{ padding: '10px' }}>Phương thức</th>
                      <th style={{ padding: '10px' }}>Nội dung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerDetailData.payments.length === 0 ? (
                      <tr><td colSpan="5" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có lịch sử thanh toán nào.</td></tr>
                    ) : (
                      customerDetailData.payments.map((pay) => (
                        <tr key={pay.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '10px', fontWeight: 'bold' }}>{pay.code || `GD-${pay.id}`}</td>
                          <td style={{ padding: '10px' }}>{pay.created_at ? new Date(pay.created_at).toLocaleDateString('vi-VN') : '---'}</td>
                          <td style={{ padding: '10px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(pay.amount)}</td>
                          <td style={{ padding: '10px' }}>{pay.method || 'Tiền mặt'}</td>
                          <td style={{ padding: '10px' }}>{pay.note || 'Thanh toán đơn hàng'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
              <button onClick={() => setShowCustomerDetailModal(false)} style={{ padding: '8px 20px', background: '#cbd5e1', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Đóng</button>
            </div>
          </div>
        </div>
      )}
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
const statBoxStyle = { background: '#f8fafc', padding: '15px', borderRadius: '8px', border: '1px solid #e2e8f0', textAlign: 'center' };
const overlayStyle = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 };
