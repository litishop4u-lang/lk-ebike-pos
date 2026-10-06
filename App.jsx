import { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';
const vnd = (n) => n.toLocaleString('vi-VN') + ' ₫';

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
  const [currentView, setCurrentView] = useState('pos'); // 'pos' | 'suppliers' | 'purchases'
  
  // States cho POS
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', note: '' });
  
  // States cho Nhà cung cấp & Nhập hàng
  const [suppliers, setSuppliers] = useState([]);
  const [newSupplier, setNewSupplier] = useState({ name: '', phone: '', address: '' });
  
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

  // --- Thêm nhà cung cấp ---
  async function handleAddSupplier(e) {
    e.preventDefault();
    try {
      await api('/api/suppliers', { method: 'POST', body: JSON.stringify(newSupplier) });
      setMsg({ type: 'ok', text: 'Đã thêm nhà cung cấp thành công' });
      setNewSupplier({ name: '', phone: '', address: '' });
      loadData();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  return (
    <div className="layout" style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>
      {/* Thanh menu bên trái */}
      <aside className="sidebar" style={{ width: '260px', background: '#1e293b', color: '#fff', padding: '20px' }}>
        <h2 style={{ fontSize: '1.2rem', marginBottom: '20px', color: '#38bdf8' }}>LK Ebike POS</h2>
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <li><button onClick={() => setCurrentView('pos')} style={navBtnStyle(currentView === 'pos')}>Tạo đơn hàng</button></li>
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

        {/* 2. MÀN HÌNH QUẢN LÝ NHÀ CUNG CẤP */}
        {currentView === 'suppliers' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
            <h2>Quản lý Nhà cung cấp</h2>
            <form onSubmit={handleAddSupplier} style={{ display: 'flex', gap: '10px', margin: '20px 0' }}>
              <input placeholder="Tên nhà cung cấp" value={newSupplier.name} onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} style={inputStyle} required />
              <input placeholder="Số điện thoại" value={newSupplier.phone} onChange={(e) => setNewSupplier({ ...newSupplier, phone: e.target.value })} style={inputStyle} />
              <input placeholder="Địa chỉ" value={newSupplier.address} onChange={(e) => setNewSupplier({ ...newSupplier, address: e.target.value })} style={inputStyle} />
              <button type="submit" style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Thêm NCC</button>
            </form>

            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
              <thead>
                <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                  <th style={{ padding: '10px' }}>Tên NCC</th>
                  <th style={{ padding: '10px' }}>Điện thoại</th>
                  <th style={{ padding: '10px' }}>Địa chỉ</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '10px' }}>{s.name}</td>
                    <td style={{ padding: '10px' }}>{s.phone || '---'}</td>
                    <td style={{ padding: '10px' }}>{s.address || '---'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 3. MÀN HÌNH NHẬP HÀNG */}
        {currentView === 'purchases' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
            <h2>Nhập hàng vào kho</h2>
            <p style={{ color: '#64748b' }}>Tính năng tạo phiếu nhập hàng và cộng tồn kho tự động.</p>
            {/* Bạn có thể mở rộng form nhập hàng tương tự phần giỏ hàng bán hàng ở đây */}
          </div>
        )}
      </main>
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

const inputStyle = { width: '100%', padding: '10px', margin: '6px 0', borderRadius: '6px', border: '1px solid #cbd5e1' };
const actionBtnStyle = { flex: 1, padding: '10px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' };

// Thêm phần state và giao diện cho Quản lý Nhà cung cấp vào App.jsx
  const [suppliers, setSuppliers] = useState([]);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [supplierTab, setSupplierTab] = useState('info'); // 'info' | 'purchases' | 'payments' | 'returns'
  const [supplierHistory, setSupplierHistory] = useState({ purchases: [], payments: [], returns: [] });
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [supplierForm, setSupplierForm] = useState({ name: '', phone: '', address: '', status: 'active' });

  const loadSuppliers = () => api('/api/suppliers').then(setSuppliers).catch(() => {});

  useEffect(() => { loadSuppliers(); }, []);

  const openSupplierDetail = async (s) => {
    setSelectedSupplier(s);
    setEditingSupplier(s);
    setSupplierForm({ name: s.name, phone: s.phone || '', address: s.address || '', status: s.status });
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
      setSupplierForm({ name: '', phone: '', address: '', status: 'active' });
      setEditingSupplier(null);
      loadSuppliers();
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
      loadSuppliers();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  };
