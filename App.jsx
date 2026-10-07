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
  const [currentView, setCurrentView] = useState('pos'); // 'pos' | 'suppliers' | 'purchases'
  
  // States cho POS
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', note: '' });
  
  // States cho Nhà cung cấp & Nhập hàng
  const [suppliers, setSuppliers] = useState([]);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ code: '', name: '', phone: '', address: '', status: 'active' });
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [supplierTab, setSupplierTab] = useState('info'); // 'info' | 'purchases' | 'payments' | 'returns'
  const [supplierHistory, setSupplierHistory] = useState({ purchases: [], payments: [], returns: [] });
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [supplierForm, setSupplierForm] = useState({ name: '', phone: '', address: '', status: 'active' });
  
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

  // --- Quản lý Nhà cung cấp ---
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

        {/* Giao diện Quản lý Nhà cung cấp & Nút mở Popup */}
<div style={{ padding: '20px' }}>
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
    <h2 style={{ margin: 0 }}>Quản lý Nhà cung cấp</h2>
    <button 
      onClick={() => {
        setSupplierForm({ code: '', name: '', phone: '', address: '', status: 'active' });
        setShowSupplierModal(true);
      }}
      style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
    >
      + Thêm nhà cung cấp
    </button>
  </div>

  {/* Bảng danh sách NCC */}
  <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
    <thead>
      <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
        <th style={{ padding: '12px' }}>Mã NCC</th>
        <th style={{ padding: '12px' }}>Tên NCC</th>
        <th style={{ padding: '12px' }}>SĐT</th>
        <th style={{ padding: '12px' }}>Địa chỉ</th>
        <th style={{ padding: '12px' }}>Trạng thái</th>
      </tr>
    </thead>
    <tbody>
      {(suppliers || []).map((s) => (
        <tr key={s.id} style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}>
          <td style={{ padding: '12px' }}>{s.code}</td>
          <td style={{ padding: '12px' }}>{s.name}</td>
          <td style={{ padding: '12px' }}>{s.phone || '-'}</td>
          <td style={{ padding: '12px' }}>{s.address || '-'}</td>
          <td style={{ padding: '12px' }}>{s.status === 'active' ? 'Hoạt động' : 'Ngừng'}</td>
        </tr>
      ))}
    </tbody>
  </table>

  {/* Popup Modal thêm NCC */}
  {showSupplierModal && (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', padding: '25px', borderRadius: '10px', width: '450px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
        <h3 style={{ marginTop: 0, marginBottom: '20px' }}>Thêm nhà cung cấp mới</h3>
        
        <form onSubmit={async (e) => {
          e.preventDefault();
          try {
            const res = await fetch(`${API}/api/suppliers`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(supplierForm)
            });
            const data = await res.json();
            if (!res.ok) {
              alert(data.error || 'Có lỗi xảy ra');
              return;
            }
            setShowSupplierModal(false);
            if (typeof loadSuppliers === 'function') loadSuppliers();
          } catch (err) {
            alert('Lỗi kết nối máy chủ');
          }
        }}>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Mã NCC (để trống sẽ tự sinh):</label>
            <input 
              placeholder="Ví dụ: NCC-001" 
              value={supplierForm.code || ''} 
              onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} 
              style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
            />
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Tên nhà cung cấp *:</label>
            <input 
              placeholder="Nhập tên nhà cung cấp" 
              value={supplierForm.name || ''} 
              onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} 
              style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
              required 
            />
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Số điện thoại:</label>
            <input 
              placeholder="Nhập số điện thoại" 
              value={supplierForm.phone || ''} 
              onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} 
              style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
            />
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Địa chỉ:</label>
            <input 
              placeholder="Nhập địa chỉ" 
              value={supplierForm.address || ''} 
              onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} 
              style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Trạng thái:</label>
            <select 
              value={supplierForm.status || 'active'} 
              onChange={(e) => setSupplierForm({ ...supplierForm, status: e.target.value })} 
              style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }}
            >
              <option value="active">Hoạt động</option>
              <option value="inactive">Ngừng hoạt động</option>
            </select>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button 
              type="button" 
              onClick={() => setShowSupplierModal(false)}
              style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Hủy
            </button>
            <button 
              type="submit" 
              style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Lưu nhà cung cấp
            </button>
          </div>
        </form>
      </div>
    </div>
  )}
</div>
            {/* POPUP CHI TIẾT NHÀ CUNG CẤP (4 TAB) */}
            {showSupplierModal && selectedSupplier && (
              <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                <div style={{ background: '#fff', width: '800px', maxHeight: '90vh', borderRadius: '12px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
                  <div style={{ padding: '20px', background: '#1e293b', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0 }}>Chi tiết: {selectedSupplier.name} ({selectedSupplier.code})</h3>
                    <button onClick={() => setShowSupplierModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer' }}>✕</button>
                  </div>

                  {/* Thanh Tabs */}
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
                            <label>Tên nhà cung cấp</label>
                            <input value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} style={inputStyle} required />
                          </div>
                          <div>
                            <label>Số điện thoại</label>
                            <input value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} style={inputStyle} />
                          </div>
                          <div style={{ gridColumn: 'span 2' }}>
                            <label>Địa chỉ</label>
                            <input value={supplierForm.address} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} style={inputStyle} />
                          </div>
                          <div>
                            <label>Trạng thái</label>
                            <select value={supplierForm.status} onChange={(e) => setSupplierForm({ ...supplierForm, status: e.target.value })} style={inputStyle}>
                              <option value="active">Hoạt động</option>
                              <option value="inactive">Ngừng</option>
                            </select>
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
                          {supplierHistory.purchases.map(p => (
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
                          {supplierHistory.payments.map(pay => (
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
                          {supplierHistory.returns.map(ret => (
                            <tr key={ret.id} style={{ borderBottom: '1px solid #e2e8f0' }}><td style={{ padding: '8px', color: '#dc2626' }}>{vnd(ret.total)}</td><td style={{ padding: '8px' }}>{ret.note || '---'}</td><td style={{ padding: '8px' }}>{ret.created_at}</td></tr>
                        ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 3. MÀN HÌNH NHẬP HÀNG */}
        {currentView === 'purchases' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
            <h2>Nhập hàng vào kho</h2>
            <p style={{ color: '#64748b' }}>Tính năng tạo phiếu nhập hàng và cộng tồn kho tự động.</p>
          </div>
        )}
      </main>
    </div>
  );
}

        {/* Nút mở Popup thêm NCC */}
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
  <h3>Quản lý Nhà cung cấp</h3>
  <button 
    onClick={() => {
      setSupplierForm({ code: '', name: '', phone: '', address: '', status: 'active' });
      setShowSupplierModal(true);
    }}
    style={{ padding: '10px 20px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
  >
    + Thêm nhà cung cấp
  </button>
</div>

{/* Popup Modal thêm / sửa NCC */}
{showSupplierModal && (
  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
    <div style={{ background: '#fff', padding: '25px', borderRadius: '10px', width: '450px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
      <h3 style={{ marginTop: 0, marginBottom: '20px' }}>Thêm nhà cung cấp mới</h3>
      
      <form onSubmit={async (e) => {
        e.preventDefault();
        try {
          const res = await fetch(`${API}/api/suppliers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(supplierForm)
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Có lỗi xảy ra');
            return;
          }
          setShowSupplierModal(false);
          // Gọi lại hàm tải danh sách nhà cung cấp ở đây
          loadSuppliers(); 
        } catch (err) {
          alert('Lỗi kết nối máy chủ');
        }
      }}>
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Mã NCC (để trống sẽ tự sinh):</label>
          <input 
            placeholder="Ví dụ: NCC-001" 
            value={supplierForm.code || ''} 
            onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} 
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Tên nhà cung cấp *:</label>
          <input 
            placeholder="Nhập tên nhà cung cấp" 
            value={supplierForm.name || ''} 
            onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} 
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
            required 
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Số điện thoại:</label>
          <input 
            placeholder="Nhập số điện thoại" 
            value={supplierForm.phone || ''} 
            onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} 
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Địa chỉ:</label>
          <input 
            placeholder="Nhập địa chỉ" 
            value={supplierForm.address || ''} 
            onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} 
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }} 
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Trạng thái:</label>
          <select 
            value={supplierForm.status || 'active'} 
            onChange={(e) => setSupplierForm({ ...supplierForm, status: e.target.value })} 
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', borderRadius: '4px', border: '1px solid #cbd5e1' }}
          >
            <option value="active">Hoạt động</option>
            <option value="inactive">Ngừng hoạt động</option>
          </select>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button 
            type="button" 
            onClick={() => setShowSupplierModal(false)}
            style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Hủy
          </button>
          <button 
            type="submit" 
            style={{ padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            Lưu nhà cung cấp
          </button>
        </div>
      </form>
    </div>
  </div>
)}

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

const inputStyle = { width: '100%', padding: '10px', margin: '6px 0', borderRadius: '6px', border: '1px solid #cbd5e1' };
const actionBtnStyle = { flex: 1, padding: '10px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' };

