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
  const [currentView, setCurrentView] = useState('pos');
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', note: '' });
  
  const [showProductModal, setShowProductModal] = useState(false);
  const [showProductImportModal, setShowProductImportModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState({ sku: '', name: '', unit: 'Cái', import_price: 0, price: 0, wholesale_price: 0, stock: 0 });
  const [productImportText, setProductImportText] = useState('');

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
    api('/api/products').then((data) => setProducts(Array.isArray(data) ? data : (data.results || []))).catch((e) => setMsg({ type: 'err', text: e.message }));
    api('/api/suppliers').then((data) => setSuppliers(Array.isArray(data) ? data : (data.results || []))).catch(() => {});
  };

  useEffect(() => { loadData(); }, []);

  const lines = useMemo(() => products.filter((p) => cart[p.id]).map((p) => ({ ...p, quantity: cart[p.id] })), [products, cart]);
  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);

  const add = (p) => setCart((c) => ({ ...c, [p.id]: (c[p.id] || 0) + 1 }));
  const setQty = (id, q) => setCart((c) => { const next = { ...c }; if (q <= 0) delete next[id]; else next[id] = q; return next; });

  async function submit(kind) {
    setBusy(true); setMsg(null);
    try {
      const body = { ...customer, items: lines.map((l) => ({ product_id: l.id, quantity: l.quantity })) };
      const r = await api(`/api/${kind}`, { method: 'POST', body: JSON.stringify(body) });
      setMsg({ type: 'ok', text: `Đã lưu thành công ${r.code}` });
      setCart({}); setCustomer({ customer_name: '', customer_phone: '', note: '' }); loadData();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  }

  const handleSaveProduct = async (e) => {
    e.preventDefault();
    try {
      if (editingProduct) {
        await api(`/api/products/${editingProduct.id}`, { method: 'PUT', body: JSON.stringify(productForm) });
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(productForm) });
      }
      setShowProductModal(false); setEditingProduct(null); loadData();
    } catch (err) { alert(err.message); }
  };

  const handleDeleteProduct = async (id) => {
    if (!confirm('Xóa sản phẩm này?')) return;
    try { await api(`/api/products/${id}`, { method: 'DELETE' }); loadData(); } catch (e) { alert(e.message); }
  };

  const handleSaveSupplier = async (e) => {
    e.preventDefault();
    try {
      if (editingSupplier) {
        await api(`/api/suppliers/${editingSupplier.id}`, { method: 'PUT', body: JSON.stringify(supplierForm) });
      } else {
        await api('/api/suppliers', { method: 'POST', body: JSON.stringify(supplierForm) });
      }
      setShowSupplierModal(false); loadData();
    } catch (err) { alert(err.message); }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>
      <aside style={{ width: '260px', background: '#1e293b', color: '#fff', padding: '20px' }}>
        <h2 style={{ color: '#38bdf8' }}>LK Ebike POS</h2>
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <li><button onClick={() => setCurrentView('pos')} style={navBtnStyle(currentView === 'pos')}>Tạo đơn hàng</button></li>
          <li><button onClick={() => setCurrentView('products')} style={navBtnStyle(currentView === 'products')}>Sản phẩm</button></li>
          <li><button onClick={() => setCurrentView('suppliers')} style={navBtnStyle(currentView === 'suppliers')}>Nhà cung cấp</button></li>
          <li><button onClick={() => setCurrentView('purchases')} style={navBtnStyle(currentView === 'purchases')}>Nhập hàng</button></li>
        </ul>
      </aside>

      <main style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {msg && <div style={{ padding: '10px', marginBottom: '15px', background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#166534' : '#991b1b' }}>{msg.text}</div>}

        {currentView === 'pos' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
            <section>
              <h1>Danh mục sản phẩm</h1>
              {products.map(p => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px', background: '#fff', marginBottom: '8px' }}>
                  <span>{p.name} - {vnd(p.price)}</span>
                  <button onClick={() => add(p)} style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '5px 10px' }}>Thêm</button>
                </div>
              ))}
            </section>
            <aside style={{ background: '#fff', padding: '20px' }}>
              <h2>Giỏ hàng</h2>
              {lines.map(l => <div key={l.id}>{l.name} x {l.quantity} = {vnd(l.price * l.quantity)}</div>)}
              <hr />
              <div><b>Tổng: {vnd(total)}</b></div>
              <input placeholder="Tên khách" value={customer.customer_name} onChange={e => setCustomer({...customer, customer_name: e.target.value})} style={inputStyle} />
              <button onClick={() => submit('invoices')} style={{ width: '100%', background: '#16a34a', color: '#fff', padding: '10px', marginTop: '10px', border: 'none' }}>Xuất hóa đơn</button>
            </aside>
          </div>
        )}

        {currentView === 'products' && (
          <div style={{ background: '#fff', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2>Sản phẩm ({products.length})</h2>
              <div>
                <button onClick={() => setShowProductImportModal(true)} style={{ marginRight: '10px', background: '#16a34a', color: '#fff', border: 'none', padding: '8px 12px' }}>📁 Nhập Excel</button>
                <button onClick={() => { setEditingProduct(null); setProductForm({sku:'', name:'', unit:'Cái', import_price:0, price:0, wholesale_price:0, stock:0}); setShowProductModal(true); }} style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 12px' }}>+ Thêm</button>
              </div>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>SKU</th><th style={{ padding: '8px' }}>Tên</th><th style={{ padding: '8px' }}>Giá lẻ</th><th style={{ padding: '8px' }}>Tồn</th><th style={{ padding: '8px' }}>Thao tác</th></tr></thead>
              <tbody>
                {products.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '8px' }}>{p.sku}</td>
                    <td style={{ padding: '8px' }}>{p.name}</td>
                    <td style={{ padding: '8px' }}>{vnd(p.price)}</td>
                    <td style={{ padding: '8px' }}>{p.stock}</td>
                    <td style={{ padding: '8px' }}>
                      <button onClick={() => { setEditingProduct(p); setProductForm(p); setShowProductModal(true); }} style={{ marginRight: '5px' }}>Sửa</button>
                      <button onClick={() => handleDeleteProduct(p.id)} style={{ color: 'red' }}>Xóa</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {currentView === 'suppliers' && (
          <div style={{ background: '#fff', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2>Nhà cung cấp</h2>
              <div>
                <button onClick={() => setShowImportModal(true)} style={{ marginRight: '10px', background: '#16a34a', color: '#fff', border: 'none', padding: '8px 12px' }}>📁 Nhập Excel NCC</button>
                <button onClick={() => { setEditingSupplier(null); setSupplierForm({code:'', name:'', phone:'', address:'', status:'active'}); setShowSupplierModal(true); }} style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 12px' }}>+ Thêm NCC</button>
              </div>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#f8fafc', textAlign: 'left' }}><th style={{ padding: '8px' }}>Mã</th><th style={{ padding: '8px' }}>Tên NCC</th><th style={{ padding: '8px' }}>SĐT</th><th style={{ padding: '8px' }}>Công nợ</th></tr></thead>
              <tbody>
                {suppliers.map(s => (
                  <tr key={s.id} onClick={async () => {
                    setSelectedSupplier(s); setEditingSupplier(s);
                    setSupplierForm({ code: s.code, name: s.name, phone: s.phone || '', address: s.address || '', status: s.status });
                    try { const hist = await api(`/api/suppliers/${s.id}/history`); setSupplierHistory(hist); } catch (e) {}
                    setShowSupplierModal(true);
                  }} style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}>
                    <td style={{ padding: '8px' }}>{s.code}</td>
                    <td style={{ padding: '8px' }}>{s.name}</td>
                    <td style={{ padding: '8px' }}>{s.phone}</td>
                    <td style={{ padding: '8px' }}>{vnd(s.total_debt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {currentView === 'purchases' && (
          <div style={{ background: '#fff', padding: '24px' }}>
            <h2>Tạo Phiếu Nhập Hàng</h2>
            <p>Chọn nhà cung cấp và tìm sản phẩm để nhập kho.</p>
          </div>
        )}
      </main>

      {/* Modal Sản phẩm */}
      {showProductModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ background: '#fff', padding: '20px', width: '400px', borderRadius: '8px' }}>
            <h3>{editingProduct ? 'Sửa sản phẩm' : 'Thêm sản phẩm'}</h3>
            <form onSubmit={handleSaveProduct}>
              <input placeholder="SKU" value={productForm.sku} onChange={e => setProductForm({...productForm, sku: e.target.value})} style={inputStyle} />
              <input placeholder="Tên sản phẩm *" value={productForm.name} onChange={e => setProductForm({...productForm, name: e.target.value})} style={inputStyle} required />
              <input placeholder="Đơn vị" value={productForm.unit} onChange={e => setProductForm({...productForm, unit: e.target.value})} style={inputStyle} />
              <input type="number" placeholder="Giá nhập" value={productForm.import_price} onChange={e => setProductForm({...productForm, import_price: e.target.value})} style={inputStyle} />
              <input type="number" placeholder="Giá lẻ" value={productForm.price} onChange={e => setProductForm({...productForm, price: e.target.value})} style={inputStyle} />
              <input type="number" placeholder="Tồn kho" value={productForm.stock} onChange={e => setProductForm({...productForm, stock: e.target.value})} style={inputStyle} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button type="button" onClick={() => setShowProductModal(false)}>Hủy</button>
                <button type="submit" style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '6px 12px' }}>Lưu</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Import Sản phẩm */}
      {showProductImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ background: '#fff', padding: '20px', width: '500px', borderRadius: '8px' }}>
            <h3>Nhập khẩu sản phẩm</h3>
            <textarea rows="6" placeholder="SKU | Tên | ĐVT | Giá nhập | Giá lẻ | Giá sỉ | Tồn kho" value={productImportText} onChange={e => setProductImportText(e.target.value)} style={{ width: '100%', fontFamily: 'monospace' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button onClick={() => setShowProductImportModal(false)}>Hủy</button>
              <button onClick={async () => {
                try {
                  const items = productImportText.split('\n').map(l => {
                    const c = l.split(/\t|,|;/).map(x => x.trim().replace(/^["']|["']$/g, ''));
                    return c.length >= 2 ? { sku: c[0], name: c[1], unit: c[2]||'Cái', import_price: Number(c[3])||0, price: Number(c[4])||0, wholesale_price: Number(c[5])||0, stock: Number(c[6])||0 } : null;
                  }).filter(Boolean);
                  const res = await api('/api/products/import', { method: 'POST', body: JSON.stringify({ items }) });
                  alert(`Nhập thành công ${res.successCount || items.length} sản phẩm!`);
                  setShowProductImportModal(false); loadData();
                } catch (err) { alert(err.message); }
              }} style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '6px 12px' }}>Xác nhận</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Nhà cung cấp */}
      {showSupplierModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ background: '#fff', padding: '20px', width: '450px', borderRadius: '8px' }}>
            <h3>{editingSupplier ? 'Sửa nhà cung cấp' : 'Thêm nhà cung cấp'}</h3>
            <form onSubmit={handleSaveSupplier}>
              <input placeholder="Mã NCC" value={supplierForm.code} onChange={e => setSupplierForm({...supplierForm, code: e.target.value})} style={inputStyle} />
              <input placeholder="Tên NCC *" value={supplierForm.name} onChange={e => setSupplierForm({...supplierForm, name: e.target.value})} style={inputStyle} required />
              <input placeholder="SĐT" value={supplierForm.phone} onChange={e => setSupplierForm({...supplierForm, phone: e.target.value})} style={inputStyle} />
              <input placeholder="Địa chỉ" value={supplierForm.address} onChange={e => setSupplierForm({...supplierForm, address: e.target.value})} style={inputStyle} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button type="button" onClick={() => setShowSupplierModal(false)}>Hủy</button>
                <button type="submit" style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '6px 12px' }}>Lưu</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Import NCC */}
      {showImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ background: '#fff', padding: '20px', width: '500px', borderRadius: '8px' }}>
            <h3>Nhập khẩu Nhà cung cấp</h3>
            <textarea rows="6" placeholder="Mã NCC | Tên NCC | SĐT | Địa chỉ" value={importText} onChange={e => setImportText(e.target.value)} style={{ width: '100%', fontFamily: 'monospace' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button onClick={() => setShowImportModal(false)}>Hủy</button>
              <button onClick={async () => {
                try {
                  const items = importText.split('\n').map(l => {
                    const c = l.split(/\t|,|;/).map(x => x.trim().replace(/^["']|["']$/g, ''));
                    return c.length >= 2 ? { code: c[0], name: c[1], phone: c[2]||'', address: c.slice(3).join(', ') } : null;
                  }).filter(Boolean);
                  const res = await api('/api/suppliers/import', { method: 'POST', body: JSON.stringify({ items }) });
                  alert(`Nhập thành công ${res.successCount || items.length} NCC!`);
                  setShowImportModal(false); loadData();
                } catch (err) { alert(err.message); }
              }} style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '6px 12px' }}>Xác nhận</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const navBtnStyle = (active) => ({ width: '100%', padding: '10px 15px', background: active ? '#0284c7' : 'transparent', color: '#fff', border: 'none', borderRadius: '6px', textAlign: 'left', cursor: 'pointer' });
const inputStyle = { width: '100%', padding: '8px', margin: '5px 0', borderRadius: '4px', border: '1px solid #cbd5e1', boxSizing: 'border-box' };
