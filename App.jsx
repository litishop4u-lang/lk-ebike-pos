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
  
  // POS states
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', note: '' });
  
  // Products states
  const [showProductModal, setShowProductModal] = useState(false);
  const [showProductImportModal, setShowProductImportModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState({ sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 });
  const [productImportText, setProductImportText] = useState('');

  // Suppliers & Purchases states
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
    api('/api/products')
      .then((data) => setProducts(Array.isArray(data) ? data : (data.results || [])))
      .catch((e) => setMsg({ type: 'err', text: e.message }));
      
    api('/api/suppliers')
      .then((data) => setSuppliers(Array.isArray(data) ? data : (data.results || [])))
      .catch(() => {});
  };

  useEffect(() => { loadData(); }, []);

  // POS logic
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

  // Product actions
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

  // Supplier actions
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
      {/* Sidebar */}
      <aside className="sidebar" style={{ width: '260px', background: '#1e293b', color: '#fff', padding: '20px' }}>
        <h2 style={{ fontSize: '1.2rem', marginBottom: '20px', color: '#38bdf8' }}>LK Ebike POS</h2>
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <li><button onClick={() => setCurrentView('pos')} style={navBtnStyle(currentView === 'pos')}>Tạo đơn hàng</button></li>
          <li><button onClick={() => setCurrentView('products')} style={navBtnStyle(currentView === 'products')}>Sản phẩm</button></li>
          <li><button onClick={() => setCurrentView('suppliers')} style={navBtnStyle(currentView === 'suppliers')}>Nhà cung cấp</button></li>
          <li><button onClick={() => setCurrentView('purchases')} style={navBtnStyle(currentView === 'purchases')}>Nhập hàng</button></li>
        </ul>
      </aside>

      {/* Main Content */}
      <main className="main-content" style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {msg && <div style={{ padding: '10px', marginBottom: '15px', borderRadius: '6px', background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#166534' : '#991b1b' }}>{msg.text}</div>}

        {/* 1. POS View */}
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

        {/* 2. Products View */}
        {currentView === 'products' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Sản phẩm ({products.length})</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => { setProductImportText(''); setShowProductImportModal(true); }} style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>📁 Nhập Excel / Dán dữ liệu</button>
                <button onClick={() => { setEditingProduct(null); setProductForm({ sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 }); setShowProductModal(true); }} style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>+ Thêm sản phẩm mới</button>
              </div>
            </div>

            <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left', position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={{ padding: '12px' }}>Mã SKU</th>
                    <th style={{ padding: '12px' }}>Tên sản phẩm</th>
                    <th style={{ padding: '12px' }}>ĐVT</th>
                    <th style={{ padding: '12px' }}>Giá nhập</th>
                    <th style={{ padding: '12px' }}>Giá lẻ</th>
                    <th style={{ padding: '12px' }}>Giá sỉ</th>
                    <th style={{ padding: '12px' }}>Tồn kho</th>
                    <th style={{ padding: '12px', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {products.length === 0 ? (
                    <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>Chưa có sản phẩm nào.</td></tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '12px' }}>{p.sku}</td>
                        <td style={{ padding: '12px', fontWeight: 'bold', color: '#0284c7' }}>{p.name}</td>
                        <td style={{ padding: '12px' }}>{p.unit}</td>
                        <td style={{ padding: '12px' }}>{vnd(p.import_price)}</td>
                        <td style={{ padding: '12px', color: '#16a34a', fontWeight: 'bold' }}>{vnd(p.price)}</td>
                        <td style={{ padding: '12px', color: '#0284c7' }}>{vnd(p.wholesale_price)}</td>
                        <td style={{ padding: '12px', color: p.stock <= 3 ? '#dc2626' : 'inherit' }}>{p.stock}</td>
                        <td style={{ padding: '12px', textAlign: 'center' }}>
                          <button onClick={() => { setEditingProduct(p); setProductForm(p); setShowProductModal(true); }} style={{ padding: '6px 12px', background: '#e0f2fe', color: '#0284c7', border: 'none', borderRadius: '4px', cursor: 'pointer', marginRight: '6px' }}>Sửa</button>
                          <button onClick={() => handleDeleteProduct(p.id)} style={{ padding: '6px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Xóa</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 3. Suppliers View */}
        {currentView === 'suppliers' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Quản lý Nhà cung cấp</h2>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => { setImportText(''); setShowImportModal(true); }} style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>📁 Nhập Excel / Dán dữ liệu</button>
                <button onClick={() => { setEditingSupplier(null); setSupplierForm({ code: '', name: '', phone: '', address: '', status: 'active' }); setShowSupplierModal(true); }} style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>+ Thêm nhà cung cấp</button>
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
                    <td style={{ padding: '12px', color: s.total_debt > 0 ? '#dc2626' : 'inherit', fontWeight: s.total_debt > 0 ? 'bold' : 'normal' }}>{vnd(s.total_debt)}</td>
                    <td style={{ padding: '12px' }}>{s.status === 'active' ? 'Hoạt động' : 'Ngừng'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 4. Purchases View */}
        {currentView === 'purchases' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginTop: 0, marginBottom: '20px' }}>Tạo Phiếu Nhập Hàng</h2>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px', marginBottom: '20px', padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ position: 'relative' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Nhà cung cấp *:</label>
                <input 
                  placeholder="Nhập tên, SĐT hoặc mã NCC..." 
                  value={supplierSearchKeyword}
                  onChange={(e) => { setSupplierSearchKeyword(e.target.value); setShowSupplierDropdown(true); }}
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
                <select value={purchaseForm.payment_method} onChange={(e) => setPurchaseForm({ ...purchaseForm, payment_method: e.target.value })} style={inputStyle}>
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
              <input placeholder="Nhập tên sản phẩm hoặc mã SKU..." value={productSearchKeyword} onChange={(e) => setProductSearchKeyword(e.target.value)} style={inputStyle} />
              {productSearchKeyword.trim() && (
                <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '150px', overflowY: 'auto', marginTop: '5px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                  {(products || []).filter(p => p.name.toLowerCase().includes(productSearchKeyword.toLowerCase()) || (p.sku && p.sku.toLowerCase().includes(productSearchKeyword.toLowerCase()))).map(p => (
                    <div key={p.id} onClick={() => {
                      const exist = purchaseItems.find(item => item.product_id === p.id);
                      if (exist) {
                        setPurchaseItems(purchaseItems.map(item => item.product_id === p.id ? { ...item, quantity: item.quantity + 1 } : item));
                      } else {
                        setPurchaseItems([...purchaseItems, { product_id: p.id, name: p.name, sku: p.sku, unit: p.unit || 'Cái', quantity: 1, price: p.import_price || p.price || 0, discount: 0 }]);
                      }
                      setProductSearchKeyword('');
                    }} style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f1f5f9' }}>
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
                    <th style={{ padding: '10px', width: '90px' }}>SL</th>
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
                          <td style={{ padding: '10px' }}><input type="number" min="1" value={item.quantity} onChange={(e) => setPurchaseItems(purchaseItems.map((it, idx) => idx === index ? { ...it, quantity: Number(e.target.value) } : idx))} style={{ width: '60px', padding: '6px', textAlign: 'center' }} /></td>
                          <td style={{ padding: '10px' }}><input type="number" value={item.price} onChange={(e) => setPurchaseItems(purchaseItems.map((it, idx) => idx === index ? { ...it, price: Number(e.target.value) } : idx))} style={{ width: '120px', padding: '6px' }} /></td>
                          <td style={{ padding: '10px' }}><input type="number" value={item.discount} onChange={(e) => setPurchaseItems(purchaseItems.map((it, idx) => idx === index ? { ...it, discount: Number(e.target.value) } : idx))} style={{ width: '100px', padding: '6px' }} /></td>
                          <td style={{ padding: '10px', fontWeight: 'bold', color: '#16a34a' }}>{vnd(lineTotal)}</td>
                          <td style={{ padding: '10px' }}><button onClick={() => setPurchaseItems(purchaseItems.filter((_, idx) => idx !== index))} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer' }}>✕</button></td>
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
                    <div><span style={{ color: '#64748b' }}>Tổng tiền: </span><b>{vnd(totalAmount)}</b></div>
                    <div><span style={{ color: '#64748b' }}>Đã trả: </span><input type="number" value={purchaseForm.paid_amount} onChange={(e) => setPurchaseForm({ ...purchaseForm, paid_amount: e.target.value })} style={{ width: '130px', padding: '6px', fontWeight: 'bold' }} /></div>
                    <div><span style={{ color: '#64748b' }}>Còn nợ: </span><b style={{ color: debtAmount > 0 ? '#dc2626' : '#16a34a' }}>{vnd(debtAmount)}</b></div>
                  </div>

                  <button onClick={async () => {
                    if (!purchaseForm.supplier_id) return alert('Vui lòng chọn nhà cung cấp!');
                    if (purchaseItems.length === 0) return alert('Chưa có sản phẩm trong phiếu nhập!');
                    try {
                      const res = await api('/api/purchase_orders', {
                        method: 'POST',
                        body: JSON.stringify({ supplier_id: purchaseForm.supplier_id, payment_method: purchaseForm.payment_method, paid_amount: Number(purchaseForm.paid_amount) || 0, items: purchaseItems })
                      });
                      setMsg({ type: 'ok', text: `Tạo phiếu nhập ${res.code} thành công!` });
                      setPurchaseItems([]); setPurchaseForm({ supplier_id: '', payment_method: 'Tiền mặt', paid_amount: 0 }); setSupplierSearchKeyword(''); loadData();
                    } catch (err) { alert('Lỗi: ' + err.message); }
                  }} style={{ padding: '12px 25px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '1rem', cursor: 'pointer', fontWeight: 'bold' }}>💾 Hoàn tất nhập hàng</button>
                </div>
              );
            })()}
          </div>
        )}
      </main>

      {/* MODAL SẢN PHẨM */}
      {showProductModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '25px', borderRadius: '10px', width: '500px' }}>
            <h3 style={{ marginTop: 0 }}>{editingProduct ? 'Sửa sản phẩm' : 'Thêm sản phẩm'}</h3>
            <form onSubmit={handleSaveProduct}>
              <div style={{ marginBottom: '10px' }}><label>SKU:</label><input value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} style={inputStyle} /></div>
              <div style={{ marginBottom: '10px' }}><label>Tên sản phẩm *:</label><input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} style={inputStyle} required /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <div><label>Đơn vị:</label><input value={productForm.unit} onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} style={inputStyle} /></div>
                <div><label>Tồn kho:</label><input type="number" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} style={inputStyle} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '15px' }}>
                <div><label>Giá nhập:</label><input type="number" value={productForm.import_price} onChange={(e) => setProductForm({ ...productForm, import_price: e.target.value })} style={inputStyle} /></div>
                <div><label>Giá lẻ:</label><input type="number" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} style={inputStyle} /></div>
                <div><label>Giá sỉ:</label><input type="number" value={productForm.wholesale_price} onChange={(e) => setProductForm({ ...productForm, wholesale_price: e.target.value })} style={inputStyle} /></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button type="button" onClick={() => setShowProductModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Hủy</button>
                <button type="submit" style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Lưu</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL IMPORT SẢN PHẨM */}
      {showProductImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px' }}>
            <h3 style={{ marginTop: 0 }}>Nhập khẩu sản phẩm</h3>
            <textarea rows="8" placeholder="SKU | Tên | ĐVT | Giá nhập | Giá lẻ | Giá sỉ | Tồn kho" value={productImportText} onChange={(e) => setProductImportText(e.target.value)} style={{ width: '100%', padding: '10px', fontFamily: 'monospace' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '15px' }}>
              <button onClick={() => setShowProductImportModal(false)} style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Hủy</button>
              <button onClick={async () => {
                try {
                  const lines = productImportText.split('\n');
                  const items = lines.map(l => {
                    const c = l.split(/\t|,|;/).map(x => x.trim().replace(/^["']|["']$/g, ''));
                    return c.length >= 2 ? { sku: c[0], name: c[1], unit: c[2] || 'Cái', import_price: Number(c[3]) || 0, price: Number(c[4]) || 0, wholesale_price: Number(c[5]) || 0, stock: Number(c[6]) || 0 } : null;
                  }).filter(Boolean);
                  const res = await api('/api/products/import', { method: 'POST', body: JSON.stringify({ items }) });
                  setMsg({ type: 'ok', text: `Nhập thành công ${res.successCount || items.length} sản phẩm!` });
                  setShowProductImportModal(false); loadData();
                } catch (err) { alert('Lỗi: ' + err.message); }
              }} style={{ padding: '8px 20px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Xác nhận</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL CHI TIẾT / THÊM NHÀ CUNG CẤP (4 TAB) */}
      {showSupplierModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
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
                        <div><label>T
