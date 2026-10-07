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
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  
  const [supplierForm, setSupplierForm] = useState({ code: '', name: '', phone: '', address: '', status: 'active' });
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [supplierTab, setSupplierTab] = useState('info'); // 'info' | 'purchases' | 'payments' | 'returns'
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

            {/* Bảng danh sách NCC */}
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

        {/* 3. MÀN HÌNH NHẬP HÀNG */}
        {currentView === 'purchases' && (
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
            <h2>Nhập hàng vào kho</h2>
            <p style={{ color: '#64748b' }}>Tính năng tạo phiếu nhập hàng và cộng tồn kho tự động.</p>
          </div>
        )}
      </main>

      {/* POPUP THÊM HOẶC CHI TIẾT NHÀ CUNG CẤP (4 TAB) */}
      {showSupplierModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', width: '800px', maxHeight: '90vh', borderRadius: '12px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <div style={{ padding: '20px', background: '#1e293b', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>{editingSupplier ? `Chi tiết: ${selectedSupplier?.name}` : 'Thêm nhà cung cấp mới'}</h3>
              <button onClick={() => setShowSupplierModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            {editingSupplier ? (
              <>
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
              /* FORM THÊM MỚI NCC */
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

      {/* POPUP IMPORT EXCEL / PASTE DỮ LIỆU */}
      {showImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '25px', borderRadius: '12px', width: '600px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Nhập khẩu danh sách Nhà cung cấp</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5' }}>
              Bạn có thể <b>copy các cột từ Excel</b> và dán trực tiếp vào ô bên dưới.<br/>
              Thứ tự cột: <code style={{ background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>Mã NCC | Tên NCC | Số điện thoại | Địa chỉ</code>
            </p>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Hoặc chọn file Excel (.csv / .txt):</label>
              <input 
                type="file" 
                accept=".csv, .txt, .tsv"
                onChange={(e) => {
                  const file = e.target.files[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (evt) => setImportText(evt.target.result);
                  reader.readAsText(file);
                }}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', marginBottom: '5px' }}>Hoặc dán (Paste) dữ liệu trực tiếp vào đây:</label>
              <textarea 
                rows="8"
                placeholder={"NCC01\tCông ty A\t0901234567\tQuận 1, TP.HCM\nNCC02\tCông ty B\t0908765432\tQuận 3, TP.HCM"}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                style={{ width: '100%', padding: '10px', boxSizing: 'border-box', borderRadius: '6px', border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: '13px' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button 
                type="button" 
                onClick={() => setShowImportModal(false)}
                style={{ padding: '8px 16px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
              >
                Hủy
              </button>
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
                      if (cols.length >= 2) {
                        let code = '', name = '', phone = '', address = '';
                        if (cols.length >= 4) {
                          code = cols[0]; name = cols[1]; phone = cols[2]; address = cols.slice(3).join(', ');
                        } else if (cols.length === 3) {
                          name = cols[0]; phone = cols[1]; address = cols.slice(2).join(', ');
                        } else {
                          name = cols[0]; phone = cols[1] || '';
                        }
                        items.push({ code, name, phone, address, status: 'active' });
                      }
                    }

                    if (items.length === 0) {
                      alert('Không đọc được dữ liệu hợp lệ. Vui lòng kiểm tra lại định dạng!');
                      return;
                    }

                    const res = await api('/api/suppliers/import', {
                      method: 'POST',
                      body: JSON.stringify({ items })
                    });

                    setMsg({ type: 'ok', text: `Nhập khẩu thành công ${res.successCount} nhà cung cấp!` });
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

const inputStyle = { width: '100%', padding: '10px', margin: '6px 0', borderRadius: '6px', border: '1px solid #cbd5e1', boxSizing: 'border-box' };
const actionBtnStyle = { flex: 1, padding: '10px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' };
