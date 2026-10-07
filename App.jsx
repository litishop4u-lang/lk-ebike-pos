import { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';
const vnd = (n) => (Number(n) || 0).toLocaleString('vi-VN') + ' ₫';

async function api(path, options) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}

export default function App() {
  const [currentView, setCurrentView] = useState('pos'); // 'pos' | 'products' | 'suppliers' | 'purchases'
  
  // States cho POS
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', note: '' });
  
  // States cho Quản lý Sản phẩm
  const [showProductModal, setShowProductModal] = useState(false);
  const [showProductImportModal, setShowProductImportModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState({ sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 });
  const [productImportText, setProductImportText] = useState('');

  // States cho Nhà cung cấp & Nhập hàng
  const [suppliers, setSuppliers] = useState([]);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  
  const [purchaseForm, setPurchaseForm] = useState({ supplier_id: '', payment_method: 'Tiền mặt', paid_amount: 0 });
  const [purchaseItems, setPurchaseItems] = useState([]);
  const [productSearchKeyword, setProductSearchKeyword] = useState('');
  const [supplierSearchKeyword, setSupplierSearchKeyword] = useState('');
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);

  const [supplierForm, setSupplierForm] = useState({ code: '', name: '', phone: '', address: '', status: 'active' });
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [supplierTab, setSupplierTab] = useState('info');
  const [supplierHistory, setSupplierHistory] = useState({ purchases: [], payments: [], returns: [] });
  const [editingSupplier, setEditingSupplier] = useState(null);
  
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadData = () => {
    api('/api/products').then(setProducts).catch((e) => setMsg({ type: 'err', text: e.message }));
    api('/api/suppliers').then(setSuppliers).catch(() => {});
  };

  useEffect(() => { loadData(); }, []);

  // --- POS Logic ---
  const lines = useMemo(
    () => products.filter((p) => cart[p.id]).map((p) => ({ ...p, quantity: cart[p.id] })),
    [products, cart]
  );
  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);

  const add = (p) => setCart((c) => ({ ...c, [p.id]: (c[p.id] || 0) + 1 }));
  const setQty = (id, q) =>
    setCart((c) => {
      const next = { ...c };
      if (q <= 0) delete next[id]; else next[id] = q;
      return next;
    });

  async function submit(kind) {
    setBusy(true); setMsg(null);
    try {
      const body = {
        ...customer,
        items: lines.map((l) => ({ product_id: l.id, quantity: l.quantity })),
      };
      const r = await api(`/api/${kind}`, { method: 'POST', body: JSON.stringify(body) });
      setMsg({ type: 'ok', text: `${kind === 'orders' ? 'Đã lưu đơn đặt hàng' : 'Đã xuất phiếu bán hàng'} ${r.code} — ${vnd(r.total)}` });
      setCart({});
      setCustomer({ customer_name: '', customer_phone: '', note: '' });
      loadData();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  // --- Quản lý Sản phẩm ---
  const handleSaveProduct = async (e) => {
    e.preventDefault();
    try {
      if (editingProduct) {
        await api(`/api/products/${editingProduct.id}`, { method: 'PUT', body: JSON.stringify(productForm) });
        setMsg({ type: 'ok', text: 'Đã cập nhật sản phẩm thành công!' });
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(productForm) });
        setMsg({ type: 'ok', text: 'Đã thêm sản phẩm thành công!' });
      }
      setShowProductModal(false);
      setEditingProduct(null);
      setProductForm({ sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 });
      loadData();
    } catch (err) {
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

  // --- Quản lý Nhà cung cấp ---
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
      setSupplierForm({ code: '', name: '', phone: '', address: '', status: 'active' });
      setEditingSupplier(null);
      loadData();
    } catch (err) {
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
      setMsg({ type: 'err', text: e.message });
    }
  };

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
        </ul>
      </aside>

      {/* Nội dung chính bên phải */}
      <main className="main-content" style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {msg && <div style={{ padding: '10px', marginBottom: '15px', borderRadius: '6px', background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#166534' : '#991b1b' }}>{msg.text}</div>}

        {/* 1. MÀN HÌNH TẠO ĐƠN HÀNG (POS) */}
        {currentView === 'pos' && (
          <div className="app" style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
            <section className="catalog">
              <h1>Xe đạp điện & Linh kiện</h1>
              <ul className="products" style={{ listStyle: 'none', padding: 0 }}>
                {products.map((p) => (
                  <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#fff', marginBottom: '8px', borderRadius: '8px', alignItems: 'center' }}>
                    <div>
                      <strong>{p.name}</strong><br />
                      <small style={{ color: '#64748b' }}>SKU: {p.sku}</small>
                    </div>
                    <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                      <span>{vnd(p.price)}</span>
                      <span style={{ color: p.stock <= 3 ? 'red' : 'green' }}>Kho: {p.stock}</span>
                      <button onClick={() => add(p)} style={{ padding: '6px 12px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Thêm</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <aside className="ticket" style={{ background: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h2>Giỏ hàng</h2>
              {lines.length === 0 && <p style={{ color: '#94a3b8' }}>Chọn sản phẩm bên trái để bắt đầu.</p>}
              {lines.map((l) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', margin: '10px 0', alignItems: 'center' }}>
                  <span>{l.name}</span>
                  <input type="number" min="1" value={l.quantity} onChange={(e) => setQty(l.id, Number(e.target.value))} style={{ width: '50px', textAlign: 'center' }} />
                  <span>{vnd(l.price * l.quantity)}</span>
                </div>
              ))}
              <hr />
              <div style={{ display: 'flex', justifyContent: 'space-between', margin: '15px 0', fontWeight: 'bold' }}>
                <span>Tổng cộng:</span><span>{vnd(total)}</span>
              </div>
              <input placeholder="Tên khách hàng" value={customer.customer_name} onChange={(e) => setCustomer({ ...customer, customer_name: e.target.value })} style={inputStyle} />
              <input placeholder="Số điện thoại" value={customer.customer_phone} onChange={(e) => setCustomer({ ...customer, customer_phone: e.target.value })} style={inputStyle} />
              <input placeholder="Ghi chú" value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} style={inputStyle} />
              
              <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
                <button disabled={!lines.length || !customer.customer_name || busy} onClick={() => submit('orders')} style={actionBtnStyle}>Lưu đơn đặt hàng</button>
                <button disabled={!lines.length || !customer.customer_name || busy} onClick={() => submit('invoices')} style={{ ...actionBtnStyle, background: '#16a34a' }}>Xuất hóa đơn</button>
              </div>
            </aside>
          </div>
        )}

        {/* 2. MÀN HÌNH QUẢN LÝ SẢN PHẨM */}
        {currentView === 'products' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
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
                  onClick={() => {
                    setEditingProduct(null);
                    setProductForm({ sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 });
                    setShowProductModal(true);
                  }}
                  style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Thêm sản phẩm mới
                </button>
              </div>
            </div>

            {/* Bảng danh sách sản phẩm */}
            <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left', position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={{ padding: '12px' }}>Mã sản phẩm (SKU)</th>
                    <th style={{ padding: '12px' }}>Tên sản phẩm</th>
                    <th style={{ padding: '12px' }}>Đơn vị tính</th>
                    <th style={{ padding: '12px' }}>Giá nhập</th>
                    <th style={{ padding: '12px' }}>Giá bán lẻ</th>
                    <th style={{ padding: '12px' }}>Giá bán sỉ</th>
                    <th style={{ padding: '12px' }}>Tồn kho</th>
                    <th style={{ padding: '12px', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {(products || []).map((p) => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '12px' }}>{p.sku}</td>
                      <td style={{ padding: '12px', fontWeight: 'bold', color: '#0284c7' }}>{p.name}</td>
                      <td style={{ padding: '12px' }}>{p.unit || 'Cái'}</td>
                      <td style={{ padding: '12px' }}>{vnd(p.import_price)}</td>
                      <td style={{ padding: '12px', color: '#16a34a', fontWeight: 'bold' }}>{vnd(p.price)}</td>
                      <td style={{ padding: '12px', color: '#0284c7' }}>{vnd(p.wholesale_price)}</td>
                      <td style={{ padding: '12px', color: p.stock <= 3 ? '#dc2626' : 'inherit', fontWeight: p.stock <= 3 ? 'bold' : 'normal' }}>
                        {p.stock}
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center' }}>
                        <button 
                          onClick={() => {
                            setEditingProduct(p);
                            setProductForm({ sku: p.sku, name: p.name, unit: p.unit || 'Cái', import_price: p.import_price || 0, price: p.price || 0, wholesale_price: p.wholesale_price || 0, stock: p.stock || 0 });
                            setShowProductModal(true);
                          }}
                          style={{ padding: '6px 12px', background: '#e0f2fe', color: '#0284c7', border: 'none', borderRadius: '4px', cursor: 'pointer', marginRight: '6px', fontWeight: '500' }}
                        >
                          Sửa
                        </button>
                        <button 
                          onClick={() => handleDeleteProduct(p.id)}
                          style={{ padding: '6px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: '500' }}
                        >
                          Xóa
                        </button>
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
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
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
                  onClick={() => {
                    setEditingSupplier(null);
                    setSupplierForm({ code: '', name: '', phone: '', address: '', status: 'active' });
                    setShowSupplierModal(true);
                  }}
                  style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  + Thêm nhà cung cấp
                </button>
              </div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={{ padding: '12px' }}>Mã NCC</th>
                  <th style={{ padding: '12px' }}>Tên NCC</th>
                  <th style={{ padding: '12px' }}>SĐT</th>
                  <th style={{ padding: '12px' }}>Địa chỉ</th>
                  <th style={{ padding: '12px' }}>Tổng giá trị nhập</th>
                  <th style={{ padding: '12px' }}>Đã thanh toán</th>
                  <th style={{ padding: '12px' }}>Công nợ</th>
                  <th style={{ padding: '12px' }}>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {(suppliers || []).map((s) => (
                  <tr key={s.id} onClick={() => openSupplierDetail(s)} style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}>
                    <td style={{ padding: '12px' }}>{s.code}</td>
                    <td style={{ padding: '12px', fontWeight: 'bold', color: '#0284c7' }}>{s.name}</td>
                    <td style={{ padding: '12px' }}>{s.phone || '-'}</td>
                    <td style={{ padding: '12px' }}>{s.address || '-'}</td>
                    <td style={{ padding: '12px' }}>{vnd(s.total_purchase)}</td>
                    <td style={{ padding: '12px', color: '#16a34a' }}>{vnd(s.total_paid)}</td>
                    <td style={{ padding: '12px', color: s.total_debt > 0 ? '#dc2626' : 'inherit', fontWeight: s.total_debt > 0 ? 'bold' : 'normal' }}>
                      {vnd(s.total_debt)}
                    </td>
                    <td style={{ padding: '12px' }}>{s.status === 'active' ? 'Hoạt động' : 'Ngừng'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 4. MÀN HÌNH NHẬP HÀNG */}
        {currentView === 'purchases' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginTop: 0, marginBottom: '20px' }}>Tạo Phiếu Nhập Hàng</h2>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px', marginBottom: '20px', padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ position: 'relative' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Nhà cung cấp *:</label>
                <input 
                  placeholder="Nhập tên, SĐT hoặc mã NCC..." 
                  value={supplierSearchKeyword}
                  onChange={(e) => {
                    setSupplierSearchKeyword(e.target.value);
                    setShowSupplierDropdown(true);
                  }}
                  onFocus={() => setShowSupplierDropdown(true)}
                  style={inputStyle}
                />
                {showSupplierDropdown && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '180px', overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                    {(suppliers || []).filter(s => 
                      s.name.toLowerCase().includes(supplierSearchKeyword.toLowerCase()) || 
                      (s.phone && s.phone.includes(supplierSearchKeyword)) || 
                      s.code.toLowerCase().includes(supplierSearchKeyword.toLowerCase())
                    ).map(s => (
                      <div 
                        key={s.id} 
                        onClick={() => {
                          setPurchaseForm({ ...purchaseForm, supplier_id: s.id });
                          setSupplierSearchKeyword(`${s.name} (${s.code} - ${s.phone || 'Không có SĐT'})`);
                          setShowSupplierDropdown(false);
                        }}
                        style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                      >
                        <b>{s.name}</b> <span style={{ color: '#64748b' }}>({s.code})</span> - SĐT: {s.phone || '---'}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Phương thức thanh toán:</label>
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
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Ngày nhập:</label>
                <input type="text" disabled value={new Date().toLocaleDateString('vi-VN')} style={{ ...inputStyle, background: '#f1f5f9' }} />
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Tìm kiếm sản phẩm để thêm vào phiếu nhập:</label>
              <input 
                placeholder="Nhập tên sản phẩm hoặc mã SKU..." 
                value={productSearchKeyword}
                onChange={(e) => setProductSearchKeyword(e.target.value)}
                style={inputStyle}
              />
              {productSearchKeyword.trim() && (
                <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '150px', overflowY: 'auto', marginTop: '5px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                  {(products || []).filter(p => 
                    p.name.toLowerCase().includes(productSearchKeyword.toLowerCase()) || 
                    (p.sku && p.sku.toLowerCase().includes(productSearchKeyword.toLowerCase()))
                  ).map(p => (
                    <div 
                      key={p.id}
                      onClick={() => {
                        const exist = purchaseItems.find(item => item.product_id === p.id);
                        if (exist) {
                          setPurchaseItems(purchaseItems.map(item => item.product_id === p.id ? { ...item, quantity: item.quantity + 1 } : item));
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
                    <th style={{ padding: '10px' }}>Mã SP (SKU)</th>
                    <th style={{ padding: '10px' }}>Tên sản phẩm</th>
                    <th style={{ padding: '10px' }}>Đơn vị tính</th>
                    <th style={{ padding: '10px', width: '90px' }}>Số lượng</th>
                    <th style={{ padding: '10px', width: '140px' }}>Đơn giá nhập</th>
                    <th style={{ padding: '10px', width: '120px' }}>Giảm giá</th>
                    <th style={{ padding: '10px' }}>Thành tiền</th>
                    <th style={{ padding: '10px', width: '60px' }}>Xóa</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseItems.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có sản phẩm nào trong phiếu nhập.</td></tr>
                  ) : (
                    purchaseItems.map((item, index) => {
                      const lineTotal = (item.quantity * item.price) - item.discount;
                      return (
                        <tr key={index} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '10px' }}>{item.sku}</td>
                          <td style={{ padding: '10px', fontWeight: '500' }}>{item.name}</td>
                          <td style={{ padding: '10px' }}>{item.unit}</td>
                          <td style={{ padding: '10px' }}>
                            <input 
                              type="number" min="1" value={item.quantity} 
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setPurchaseItems(purchaseItems.map((it, idx) => idx === index ? { ...it, quantity: val } : it));
                              }} 
                              style={{ width: '60px', padding: '6px', textAlign: 'center', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
                            />
                          </td>
                          <td style={{ padding: '10px' }}>
                            <input 
                              type="number" value={item.price} 
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setPurchaseItems(purchaseItems.map((it, idx) => idx === index ? { ...it, price: val } : it));
                              }} 
                              style={{ width: '120px', padding: '6px', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
                            />
                          </td>
                          <td style={{ padding: '10px' }}>
                            <input 
                              type="number" value={item.discount} 
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setPurchaseItems(purchaseItems.map((it, idx) => idx === index ? { ...it, discount: val } : it));
                              }} 
                              style={{ width: '100px', padding: '6px', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
                            />
                          </td>
                          <td style={{ padding: '10px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(lineTotal)}</td>
                          <td style={{ padding: '10px' }}>
                            <button 
                              onClick={() => setPurchaseItems(purchaseItems.filter((_, idx) => idx !== index))}
                              style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer' }}
                            >
                              ✕
                            </button>
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
                  <div style={{ display: 'flex', gap: '30px', alignItems: 'center' }}>
                    <div>
                      <span style={{ color: '#64748b' }}>Tổng tiền hàng: </span>
                      <b style={{ fontSize: '1.1rem' }}>{vnd(totalAmount)}</b>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Đã thanh toán: </span>
                      <input 
                        type="number" 
                        value={purchaseForm.paid_amount} 
                        onChange={(e) => setPurchaseForm({ ...purchaseForm, paid_amount: e.target.value })}
                        style={{ width: '130px', padding: '6px', marginLeft: '8px', borderRadius: '4px', border: '1px solid #cbd5e1', fontWeight: 'bold' }} 
                      />
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Còn nợ: </span>
                      <b style={{ fontSize: '1.1rem', color: debtAmount > 0 ? '#dc2626' : '#16a34a' }}>{vnd(debtAmount)}</b>
                    </div>
                  </div>

                  <button 
                    onClick={async () => {
                      if (!purchaseForm.supplier_id) {
                        alert('Vui lòng chọn nhà cung cấp!');
                        return;
                      }
                      if (purchaseItems.length === 0) {
                        alert('Vui lòng chọn ít nhất một sản phẩm nhập kho!');
                        return;
                      }
                      try {
                        const res = await api('/api/purchase_orders', {
                          method: 'POST',
                          body: JSON.stringify({
                            supplier_id: purchaseForm.supplier_id,
                            payment_method: purchaseForm.payment_method,
                            paid_amount: Number(purchaseForm.paid_amount) || 0,
                            items: purchaseItems
                          })
                        });
                        setMsg({ type: 'ok', text: `Tạo phiếu nhập hàng ${res.code} thành công!` });
                        setPurchaseItems([]);
                        setPurchaseForm({ supplier_id: '', payment_method: 'Tiền mặt', paid_amount: 0 });
                        setSupplierSearchKeyword('');
                        loadData();
                      } catch (err) {
                        alert('Lỗi tạo phiếu nhập: ' + err.message);
                      }
                    }}
                    style={{ padding: '12px 25px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '1rem', cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    💾 Hoàn tất nhập hàng
                  </button>
                </div>
              );
            })()}
          </div>
        )}
      </main>

      {/* MODAL THÊM / SỬA SẢN PHẨM */}
      {showProductModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '25px', borderRadius: '10px', width: '500px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '20px' }}>{editingProduct ? 'Chỉnh sửa sản phẩm' : 'Thêm sản phẩm mới'}</h3>
            <form onSubmit={handleSaveProduct}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Mã sản phẩm (SKU):</label>
                <input placeholder="VD: SKU001" value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} style={inputStyle} />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Tên sản phẩm *:</label>
                <input placeholder="Nhập tên sản phẩm" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} style={inputStyle} required />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Đơn vị tính:</label>
                  <input placeholder="Cái, Bộ, Chiếc..." value={productForm.unit} onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} style={inputStyle} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Tồn kho:</label>
                  <input type="number" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} style={inputStyle} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Giá nhập:</label>
                  <input type="number" value={productForm.import_price} onChange={(e) => setProductForm({ ...productForm, import_price: e.target.value })} style={inputStyle} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Giá bán lẻ:</label>
                  <input type="number" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} style={inputStyle} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Giá bán sỉ:</label>
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

      {/* MODAL IMPORT SẢN PHẨM (EXCEL / PASTE) */}
      {showProductImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Nhập khẩu danh sách Sản phẩm</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5' }}>
              Copy các cột từ Excel và dán trực tiếp vào ô bên dưới.<br/>
              Thứ tự cột: <code style={{ background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>Mã SKU | Tên SP | Đơn vị | Giá nhập | Giá lẻ | Giá sỉ | Tồn kho</code>
            </p>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Hoặc chọn file (.csv / .txt):</label>
              <input 
                type="file" 
                accept=".csv, .txt, .tsv"
                onChange={(e) => {
                  const file = e.target.files[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (evt) => setProductImportText(evt.target.result);
                  reader.readAsText(file);
                }}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Dán dữ liệu trực tiếp:</label>
              <textarea 
                rows="8"
                placeholder={"SP01\tXe đạp điện A\tCái\t8000000\t10000000\t9000000\t5\nSP02\tPin Lithium\tCục\t2000000\t3000000\t2500000\t10"}
                value={productImportText}
                onChange={(e) => setProductImportText(e.target.value)}
                style={{ width: '100%', padding: '10px', boxSizing: 'border-box', borderRadius: '6px', border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: '13px' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button type="button" onClick={() => setShowProductImportModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
              <button 
                type="button" 
                onClick={async () => {
                  if (!productImportText.trim()) {
                    alert('Vui lòng nhập hoặc dán dữ liệu!');
                    return;
                  }
                  try {
                    const lines = productImportText.split('\n');
                    const items = [];
                    for (let line of lines) {
                      if (!line.trim()) continue;
                      const cols = line.split(/\t|,|;/).map(c => c.trim().replace(/^["']|["']$/g, ''));
                      if (cols.length >= 2) {
                        items.push({
                          sku: cols[0],
                          name: cols[1],
                          unit: cols[2] || 'Cái',
                          import_price: Number(cols[3]) || 0,
                          price: Number(cols[4]) || 0,
                          wholesale_price: Number(cols[5]) || 0,
                          stock: Number(cols[6]) || 0
                        });
                      }
                    }

                    if (items.length === 0) {
                      alert('Không đọc được dữ liệu hợp lệ!');
                      return;
                    }

                    const res = await api('/api/products/import', {
                      method: 'POST',
                      body: JSON.stringify({ items })
                    });

                    setMsg({ type: 'ok', text: `Nhập khẩu thành công ${res.successCount || items.length} sản phẩm!` });
                    setShowProductImportModal(false);
                    loadData();
                  } catch (err) {
                    alert('Lỗi nhập khẩu: ' + err.message);
                  }
                }}
                style={{ padding: '8px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Xác nhận nhập khẩu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL THÊM / SỬA NCC */}
      {showSupplierModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', width: '800px', maxHeight: '90vh', borderRadius: '12px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
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
                        <div>
                          <label>Mã NCC</label>
                          <input value={supplierForm.code || ''} onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label>Tên nhà cung cấp *</label>
                          <input value={supplierForm.name || ''} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} style={inputStyle} required />
                        </div>
                        <div>
                          <label>Số điện thoại</label>
                          <input value={supplierForm.phone || ''} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label>Trạng thái</label>
                          <select value={supplierForm.status || 'active'} onChange={(e) => setSupplierForm({ ...supplierForm, status: e.target.value })} style={inputStyle}>
                            <option value="active">Hoạt động</option>
                            <option value="inactive">Ngừng</option>
                          </select>
                        </div>
                        <div style={{ gridColumn: 'span 2' }}>
                          <label>Địa chỉ</label>
                          <input value={supplierForm.address || ''} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} style={inputStyle} />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                        <button type="submit" style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Cập nhật thông tin</button>
                        <button type="button" onClick={() => handleDeleteSupplier(selectedSupplier.id)} style={{ padding: '10px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Xóa nhà cung cấp</button>
                      </div>
                    </form>
                  )}

                  {supplierTab === 'purchases' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Mã phiếu</th><th style={{ padding: '8px' }}>Tổng tiền</th><th style={{ padding: '8px' }}>Ngày nhập</th></tr>
                      </thead>
                      <tbody>
                        {(supplierHistory.purchases || []).map(p => (
                          <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px' }}>{p.code}</td><td style={{ padding: '8px' }}>{vnd(p.total)}</td><td style={{ padding: '8px' }}>{p.created_at}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {supplierTab === 'payments' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Số tiền thanh toán</th><th style={{ padding: '8px' }}>Ghi chú</th><th style={{ padding: '8px' }}>Thời gian</th></tr>
                      </thead>
                      <tbody>
                        {(supplierHistory.payments || []).map(pay => (
                          <tr key={pay.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px', color: '#16a34a' }}>{vnd(pay.amount)}</td><td style={{ padding: '8px' }}>{pay.note || '---'}</td><td style={{ padding: '8px' }}>{pay.created_at}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {supplierTab === 'returns' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Tổng giá trị trả</th><th style={{ padding: '8px' }}>Ghi chú</th><th style={{ padding: '8px' }}>Thời gian</th></tr>
                      </thead>
                      <tbody>
                        {(supplierHistory.returns || []).map(ret => (
                          <tr key={ret.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px', color: '#dc2626' }}>{vnd(ret.total)}</td><td style={{ padding: '8px' }}>{ret.note || '---'}</td><td style={{ padding: '8px' }}>{ret.created_at}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : (
              <form onSubmit={handleSaveSupplier} style={{ padding: '20px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Mã NCC (để trống sẽ tự sinh):</label>
                  <input placeholder="Ví dụ: NCC-001" value={supplierForm.code || ''} onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} style={inputStyle} />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Tên nhà cung cấp *:</label>
                  <input placeholder="Nhập tên nhà cung cấp" value={supplierForm.name || ''} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} style={inputStyle} required />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Số điện thoại:</label>
                  <input placeholder="Nhập số điện thoại" value={supplierForm.phone || ''} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} style={inputStyle} />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Địa chỉ:</label>
                  <input placeholder="Nhập địa chỉ" value={supplierForm.address || ''} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} style={inputStyle} />
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Trạng thái:</label>
                  <select value={supplierForm.status || 'active'} onChange={(e) => setSupplierForm({ ...supplierForm, status: e.target.value })} style={inputStyle}>
                    <option value="active">Hoạt động</option>
                    <option value="inactive">Ngừng hoạt động</option>
                  </select>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button type="button" onClick={() => setShowSupplierModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Hủy</button>
                  <button type="submit" style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Lưu nhà cung cấp</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const navBtnStyle = (active) => ({
  width: '100%',
  padding: '10px 15px',
  background: active ? '#0284c7' : 'transparent',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  textAlign: 'left',
  cursor: 'pointer',
  fontWeight: active ? 'bold' : 'normal'
});

const tabBtnStyle = (active) => ({
  flex: 1,
  padding: '12px',
  background: active ? '#fff' : 'transparent',
  border: 'none',
  borderBottom: active ? '3px solid #0284c7' : 'none',
  fontWeight: active ? 'bold' : 'normal',
  color: active ? '#0284c7' : '#64748b',
  cursor: 'pointer'
});

{/* POPUP IMPORT NHÀ CUNG CẤP (DÁN VÀO TRƯỚC THẺ ĐÓNG CUỐI CÙNG CỦA FILE APP.JSX) */}
      {showImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Nhập khẩu danh sách Nhà cung cấp</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5' }}>
              Copy các cột từ Excel và dán trực tiếp vào ô bên dưới.<br/>
              Thứ tự cột: <code style={{ background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>Mã NCC | Tên NCC | Số điện thoại | Địa chỉ</code>
            </p>

            <div style={{ marginBottom: '15px' }}>
              <textarea 
                rows="8"
                placeholder={"NCC01\tCông ty A\t0901234567\tQuận 1, TP.HCM\nNCC02\tCông ty B\t0908765432\tQuận 3, TP.HCM"}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                style={{ width: '100%', padding: '10px', boxSizing: 'border-box', borderRadius: '6px', border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: '13px' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button type="button" onClick={() => setShowImportModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
              <button 
                type="button" 
                onClick={async () => {
                  if (!importText.trim()) {
                    alert('Vui lòng nhập hoặc dán dữ liệu!');
                    return;
                  }
                  try {
                    const lines = importText.split('\n');
                    const items = [];
                    for (let line of lines) {
                      if (!line.trim()) continue;
                      const cols = line.split(/\t|,|;/).map(c => c.trim().replace(/^["']|["']$/g, ''));
                      if (cols.length > 0 && cols[0]) {
                        let code = '', name = '', phone = '', address = '';
                        if (cols.length >= 4) {
                          code = cols[0]; name = cols[1]; phone = cols[2]; address = cols.slice(3).join(', ');
                        } else if (cols.length === 3) {
                          name = cols[0]; phone = cols[1]; address = cols.slice(2).join(', ');
                        } else if (cols.length === 2) {
                          name = cols[0]; phone = cols[1];
                        } else {
                          name = cols[0];
                        }
                        items.push({ code, name, phone, address, status: 'active' });
                      }
                    }

                    if (items.length === 0) {
                      alert('Không đọc được dữ liệu hợp lệ!');
                      return;
                    }

                    const res = await api('/api/suppliers/import', {
                      method: 'POST',
                      body: JSON.stringify({ items })
                    });

                    setMsg({ type: 'ok', text: `Nhập khẩu thành công ${res.successCount || items.length} nhà cung cấp!` });
                    setShowImportModal(false);
                    loadData();
                  } catch (err) {
                    alert('Lỗi nhập khẩu: ' + err.message);
                  }
                }}
                style={{ padding: '8px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Xác nhận nhập khẩu
              </button>
            </div>
          </div>
        </div>
      )}

const inputStyle = { width: '100%', padding: '10px', margin: '6px 0', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' };
const actionBtnStyle = { flex: 1, padding: '10px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' };
