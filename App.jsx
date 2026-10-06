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
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({}); // { product_id: quantity }
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', note: '' });
  const [msg, setMsg] = useState(null); // { type: 'ok' | 'err', text }
  const [busy, setBusy] = useState(false);

  const loadProducts = () => api('/api/products').then(setProducts).catch((e) => setMsg({ type: 'err', text: e.message }));
  useEffect(() => { loadProducts(); }, []);

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
      loadProducts(); // cập nhật tồn kho mới
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = lines.length > 0 && customer.customer_name.trim() && !busy;

  return (
    <div className="app">
      <section className="catalog">
        <h1>Xe đạp điện</h1>
        <ul className="products">
          {products.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.name}</strong>
                <span className="sku">{p.sku}</span>
              </div>
              <div className="meta">
                <span className="price">{vnd(p.price)}</span>
                <span className={p.stock <= 3 ? 'stock low' : 'stock'}>Kho: {p.stock}</span>
                <button onClick={() => add(p)}>Thêm</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <aside className="ticket">
        <h2>Giỏ hàng</h2>
        {lines.length === 0 && <p className="empty">Chọn sản phẩm bên trái để bắt đầu.</p>}
        {lines.map((l) => (
          <div className="line" key={l.id}>
            <span>{l.name}</span>
            <input type="number" min="0" value={l.quantity} onChange={(e) => setQty(l.id, Number(e.target.value))} />
            <span className="amount">{vnd(l.price * l.quantity)}</span>
          </div>
        ))}
        <div className="total"><span>Tổng cộng</span><strong>{vnd(total)}</strong></div>

        <input placeholder="Tên khách hàng" value={customer.customer_name}
          onChange={(e) => setCustomer({ ...customer, customer_name: e.target.value })} />
        <input placeholder="Số điện thoại" value={customer.customer_phone}
          onChange={(e) => setCustomer({ ...customer, customer_phone: e.target.value })} />
        <input placeholder="Ghi chú" value={customer.note}
          onChange={(e) => setCustomer({ ...customer, note: e.target.value })} />

        <div className="actions">
          <button className="secondary" disabled={!canSubmit} onClick={() => submit('orders')}>
            Lưu đơn đặt hàng
          </button>
          <button disabled={!canSubmit} onClick={() => submit('invoices')}>
            Xuất phiếu bán hàng
          </button>
        </div>
        <p className="hint">Đơn đặt hàng giữ nguyên tồn kho. Phiếu bán hàng trừ kho ngay.</p>
        {msg && <p className={`msg ${msg.type}`} role="status">{msg.text}</p>}
      </aside>
    </div>
  );
}
