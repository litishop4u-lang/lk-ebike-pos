// Cloudflare Worker + D1 — API cho POS xe đạp điện
const json = (data, status = 200, origin = '*') =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const genCode = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

function parseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Giỏ hàng trống');
  const map = new Map();
  for (const it of items) {
    const id = Number(it.product_id), qty = Number(it.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty <= 0)
      throw new HttpError(400, 'Sản phẩm hoặc số lượng không hợp lệ');
    map.set(id, (map.get(id) || 0) + qty);
  }
  return map;
}

async function loadLines(db, qtyMap, { checkStock }) {
  const ids = [...qtyMap.keys()];
  const { results } = await db
    .prepare(`SELECT id, name, price, stock FROM products WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all();
  if (results.length !== ids.length) throw new HttpError(404, 'Có sản phẩm không tồn tại');
  return results.map((p) => {
    const quantity = qtyMap.get(p.id);
    if (checkStock && p.stock < quantity)
      throw new HttpError(409, `"${p.name}" chỉ còn ${p.stock} trong kho`);
    return { product_id: p.id, quantity, unit_price: p.price };
  });
}

const totalOf = (lines) => lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

async function createOrder(db, body) {
  const name = String(body.customer_name || '').trim();
  if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const lines = await loadLines(db, parseItems(body.items), { checkStock: false });
  const code = genCode('DH');

  await db.batch([
    db.prepare('INSERT INTO orders (code, customer_name, customer_phone, note, total) VALUES (?,?,?,?,?)')
      .bind(code, name, body.customer_phone || null, body.note || null, totalOf(lines)),
    ...lines.map((l) =>
      db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ((SELECT id FROM orders WHERE code = ?),?,?,?)')
        .bind(code, l.product_id, l.quantity, l.unit_price)),
  ]);
  return { code, total: totalOf(lines) };
}

async function createInvoice(db, body) {
  const name = String(body.customer_name || '').trim();
  if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const lines = await loadLines(db, parseItems(body.items), { checkStock: true });
  const code = genCode('HD');
  const orderId = body.order_id ? Number(body.order_id) : null;

  const stmts = [
    db.prepare('INSERT INTO invoices (code, order_id, customer_name, customer_phone, note, total) VALUES (?,?,?,?,?,?)')
      .bind(code, orderId, name, body.customer_phone || null, body.note || null, totalOf(lines)),
    ...lines.map((l) =>
      db.prepare('INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price) VALUES ((SELECT id FROM invoices WHERE code = ?),?,?,?)')
        .bind(code, l.product_id, l.quantity, l.unit_price)),
    ...lines.map((l) =>
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)),
  ];
  if (orderId)
    stmts.push(db.prepare("UPDATE orders SET status = 'invoiced' WHERE id = ? AND status = 'pending'").bind(orderId));

  try {
    await db.batch(stmts);
  } catch (e) {
    if (/CHECK constraint|constraint failed/i.test(String(e.message)))
      throw new HttpError(409, 'Tồn kho vừa thay đổi, không đủ hàng. Vui lòng tải lại và thử lại');
    throw e;
  }
  return { code, total: totalOf(lines) };
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const url = new URL(request.url);
    const { pathname } = url;
    const db = env.DB;

    if (request.method === 'OPTIONS') return json(null, 204, origin);

    try {
      // 1. Sản phẩm (GET, POST, IMPORT, PUT, DELETE)
      if (pathname === '/api/products' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM products ORDER BY id DESC').all();
        const formattedProducts = (results || []).map(p => ({
          id: p.id,
          sku: p.sku || p.code || '',
          name: p.name || '',
          unit: p.unit || 'Cái',
          import_price: p.import_price || p.cost_price || 0,
          price: p.price || p.retail_price || 0,
          wholesale_price: p.wholesale_price || 0,
          stock: p.stock || p.quantity || 0
        }));
        return json(formattedProducts, 200, origin);
      }

      if (pathname === '/api/products' && request.method === 'POST') {
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên sản phẩm');
        
        const sku = String(b.sku || '').trim() || genCode('SP');
        const unit = String(b.unit || '').trim() || 'Cái';
        const import_price = Number(b.import_price) || 0;
        const price = Number(b.price) || 0;
        const wholesale_price = Number(b.wholesale_price) || 0;
        const stock = Number(b.stock) || 0;

        try {
          await db.prepare(`
            INSERT INTO products (sku, name, unit, import_price, price, wholesale_price, stock)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(sku, name, unit, import_price, price, wholesale_price, stock).run();
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            throw new HttpError(400, 'Trùng mã SKU sản phẩm');
          }
          throw err;
        }

        return json({ success: true }, 201, origin);
      }

      if (pathname === '/api/products/import' && request.method === 'POST') {
        const body = await request.json();
        const items = body.items || [];
        
        let successCount = 0;
        let errorCount = 0;

        for (const item of items) {
          const name = String(item.name || '').trim();
          if (!name) {
            errorCount++;
            continue;
          }
          
          const sku = String(item.sku || '').trim() || 'SP-' + Math.floor(100000 + Math.random() * 900000);
          const unit = String(item.unit || '').trim() || 'Cái';
          const import_price = Number(item.import_price) || 0;
          const price = Number(item.price) || 0;
          const wholesale_price = Number(item.wholesale_price) || 0;
          const stock = Number(item.stock) || 0;

          try {
            await db.prepare(`
              INSERT INTO products (sku, name, unit, import_price, price, wholesale_price, stock) 
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(sku) DO UPDATE SET 
                name = excluded.name,
                unit = excluded.unit,
                import_price = excluded.import_price,
                price = excluded.price,
                wholesale_price = excluded.wholesale_price,
                stock = excluded.stock
            `).bind(sku, name, unit, import_price, price, wholesale_price, stock).run();
            successCount++;
          } catch (e) {
            errorCount++;
          }
        }

        return json({ success: true, successCount, errorCount }, 200, origin);
      }

      if (pathname.match(/^\/api\/products\/\d+$/) && request.method === 'PUT') {
        const id = pathname.split('/')[3];
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên sản phẩm');
        
        const sku = String(b.sku || '').trim() || 'SP-' + id;
        const unit = String(b.unit || '').trim() || 'Cái';
        const import_price = Number(b.import_price) || 0;
        const price = Number(b.price) || 0;
        const wholesale_price = Number(b.wholesale_price) || 0;
        const stock = Number(b.stock) || 0;

        await db.prepare(`
          UPDATE products 
          SET sku = ?, name = ?, unit = ?, import_price = ?, price = ?, wholesale_price = ?, stock = ? 
          WHERE id = ?
        `).bind(sku, name, unit, import_price, price, wholesale_price, stock, id).run();

        return json({ success: true }, 200, origin);
      }

      if (pathname.match(/^\/api\/products\/\d+$/) && request.method === 'DELETE') {
        const id = pathname.split('/')[3];
        await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // POST /api/invoices — Tạo phiếu bán hàng (Trừ tồn kho, chặn nếu hết hàng)
      if (pathname === '/api/invoices' && request.method === 'POST') {
        const b = await request.json();
        const customer_name = String(b.customer_name || '').trim();
        const customer_phone = String(b.customer_phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const created_at = b.created_at || new Date().toISOString();
        const items = b.items || [];
        const paid_amount = Number(b.paid_amount) || 0;
        const payment_method = b.payment_method || 'Tiền mặt';

        if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
        if (items.length === 0) throw new HttpError(400, 'Giỏ hàng trống');

        // Kiểm tra tồn kho trước khi xuất phiếu
        for (const item of items) {
          const prod = await db.prepare('SELECT * FROM products WHERE id = ?').bind(item.product_id).first();
          if (!prod) throw new HttpError(404, `Không tìm thấy sản phẩm ID ${item.product_id}`);
          if (prod.stock < item.quantity) {
            throw new HttpError(400, `Sản phẩm "${prod.name}" chỉ còn lại ${prod.stock} trong kho, không đủ bán!`);
          }
        }

        let total = 0;
        for (const item of items) {
          total += (item.quantity * item.price) - (item.discount || 0);
        }
        const debt = total - paid_amount;
        const code = genCode('BH');

        const stmts = [
          db.prepare('INSERT INTO invoices (code, customer_name, customer_phone, total, paid_amount, debt, created_at, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(code, customer_name, customer_phone, total, paid_amount, debt, created_at, payment_method)
        ];

        for (const item of items) {
          const lineTotal = (item.quantity * item.price) - (item.discount || 0);
          stmts.push(
            db.prepare('INSERT INTO invoice_items (invoice_id, product_id, quantity, price, discount, total) VALUES ((SELECT id FROM invoices WHERE code = ?), ?, ?, ?, ?, ?)')
              .bind(code, item.product_id, item.quantity, item.price, item.discount || 0, lineTotal)
          );
          // Trừ trực tiếp tồn kho
          stmts.push(
            db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?')
              .bind(item.quantity, item.product_id)
          );
        }

        await db.batch(stmts);
        return json({ success: true, code, total }, 201, origin);
      }

      // POST /api/orders — Tạo đơn đặt hàng (Không trừ tồn kho, cho phép đặt hàng hết)
      if (pathname === '/api/orders' && request.method === 'POST') {
        const b = await request.json();
        const customer_name = String(b.customer_name || '').trim();
        const customer_phone = String(b.customer_phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const created_at = b.created_at || new Date().toISOString();
        const items = b.items || [];
        const paid_amount = Number(b.paid_amount) || 0;
        const payment_method = b.payment_method || 'Tiền mặt';

        if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
        if (items.length === 0) throw new HttpError(400, 'Giỏ hàng trống');

        let total = 0;
        for (const item of items) {
          total += (item.quantity * item.price) - (item.discount || 0);
        }
        const debt = total - paid_amount;
        const code = genCode('DH');

        const stmts = [
          db.prepare('INSERT INTO orders (code, customer_name, customer_phone, total, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(code, customer_name, customer_phone, total, created_at, 'Pending')
        ];

        for (const item of items) {
          const lineTotal = (item.quantity * item.price) - (item.discount || 0);
          stmts.push(
            db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price, discount, total) VALUES ((SELECT id FROM orders WHERE code = ?), ?, ?, ?, ?, ?)')
              .bind(code, item.product_id, item.quantity, item.price, item.discount || 0, lineTotal)
          );
        }

        await db.batch(stmts);
        return json({ success: true, code, total }, 201, origin);
      }

      // 3. Nhà cung cấp & Nhập hàng
      if (pathname === '/api/suppliers' && request.method === 'GET') {
        const query = `
          SELECT 
            s.*,
            COALESCE(p.total_purchase, 0) as total_purchase,
            COALESCE(pay.total_paid, 0) as total_paid,
            (COALESCE(p.total_purchase, 0) - COALESCE(pay.total_paid, 0)) as total_debt
          FROM suppliers s
          LEFT JOIN (
            SELECT supplier_id, SUM(total) as total_purchase 
            FROM purchase_orders 
            GROUP BY supplier_id
          ) p ON s.id = p.supplier_id
          LEFT JOIN (
            SELECT supplier_id, SUM(amount) as total_paid 
            FROM supplier_payments 
            GROUP BY supplier_id
          ) pay ON s.id = pay.supplier_id
          ORDER BY s.id DESC
        `;
        const { results } = await db.prepare(query).all();
        return json(results || [], 200, origin);
      }

      if (pathname === '/api/suppliers' && request.method === 'POST') {
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        
        const code = String(b.code || '').trim() || genCode('NCC');
        const phone = String(b.phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const status = b.status || 'active';

        try {
          await db.prepare('INSERT INTO suppliers (code, name, phone, address, status) VALUES (?, ?, ?, ?, ?)')
            .bind(code, name, phone, address, status).run();
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            throw new HttpError(400, 'Trùng mã NCC');
          }
          throw err;
        }
          
        return json({ success: true, code }, 201, origin);
      }

      if (pathname === '/api/suppliers/import' && request.method === 'POST') {
        const body = await request.json();
        const items = body.items || [];
        
        let successCount = 0;
        let errorCount = 0;

        for (const item of items) {
          const name = String(item.name || '').trim();
          if (!name) {
            errorCount++;
            continue;
          }
          const code = String(item.code || '').trim() || genCode('NCC');
          const phone = String(item.phone || '').trim() || null;
          const address = String(item.address || '').trim() || null;
          const status = item.status === 'inactive' ? 'inactive' : 'active';

          try {
            const existing = await db.prepare('SELECT id FROM suppliers WHERE code = ?').bind(code).first();
            if (existing) {
              await db.prepare('UPDATE suppliers SET name = ?, phone = ?, address = ?, status = ? WHERE code = ?')
                .bind(name, phone, address, status, code).run();
            } else {
              await db.prepare('INSERT INTO suppliers (code, name, phone, address, status) VALUES (?, ?, ?, ?, ?)')
                .bind(code, name, phone, address, status).run();
            }
            successCount++;
          } catch (e) {
            errorCount++;
          }
        }

        return json({ success: true, successCount, errorCount }, 200, origin);
      }
      
      if (pathname.match(/^\/api\/suppliers\/\d+$/) && request.method === 'PUT') {
        const id = pathname.split('/')[3];
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        
        const code = String(b.code || '').trim() || 'NCC-DEFAULT';
        const phone = String(b.phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const status = b.status || 'active';

        try {
          await db.prepare('UPDATE suppliers SET code = ?, name = ?, phone = ?, address = ?, status = ? WHERE id = ?')
            .bind(code, name, phone, address, status, id).run();
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            throw new HttpError(400, 'Trùng mã NCC');
          }
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (pathname.match(/^\/api\/suppliers\/\d+$/) && request.method === 'DELETE') {
        const id = pathname.split('/')[3];
        await db.prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      if (pathname.match(/^\/api\/suppliers\/\d+\/history$/) && request.method === 'GET') {
        const id = pathname.split('/')[3];
        let purchases = { results: [] };
        let payments = { results: [] };
        let returns = { results: [] };

        try { purchases = await db.prepare('SELECT * FROM purchase_orders WHERE supplier_id = ? ORDER BY id DESC').bind(id).all(); } catch (e) {}
        try { payments = await db.prepare('SELECT * FROM supplier_payments WHERE supplier_id = ? ORDER BY id DESC').bind(id).all(); } catch (e) {}
        try { returns = await db.prepare('SELECT * FROM supplier_returns WHERE supplier_id = ? ORDER BY id DESC').bind(id).all(); } catch (e) {}

        return json({ 
          purchases: purchases.results || [], 
          payments: payments.results || [], 
          returns: returns.results || [] 
        }, 200, origin);
      }

      if (pathname === '/api/purchase_orders' && request.method === 'POST') {
        const body = await request.json();
        const supplier_id = body.supplier_id;
        const payment_method = body.payment_method || 'Tiền mặt';
        const paid_amount = Number(body.paid_amount) || 0;
        const items = body.items || [];

        if (!supplier_id) throw new HttpError(400, 'Vui lòng chọn nhà cung cấp');
        if (items.length === 0) throw new HttpError(400, 'Phiếu nhập chưa có sản phẩm nào');

        const code = genCode('PN');
        let total = 0;
        for (const item of items) {
          const qty = Number(item.quantity) || 0;
          const price = Number(item.price) || 0;
          const discount = Number(item.discount) || 0;
          total += (qty * price) - discount;
        }

        const debt = total - paid_amount;
        const poRes = await db.prepare(`
          INSERT INTO purchase_orders (code, supplier_id, total, paid_amount, debt, payment_method) 
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(code, supplier_id, total, paid_amount, debt, payment_method).run();

        for (const item of items) {
          const product_id = item.product_id;
          const quantity = Number(item.quantity) || 0;
          const price = Number(item.price) || 0;
          const discount = Number(item.discount) || 0;
          const lineTotal = (quantity * price) - discount;

          await db.prepare(`
            INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, price, discount, total)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(poRes.meta.last_row_id, product_id, quantity, price, discount, lineTotal).run();

          await db.prepare(`
            UPDATE products SET stock = stock + ? WHERE id = ?
          `).bind(quantity, product_id).run();
        }

        return json({ success: true, code, total }, 201, origin);
      }

        // GET /api/purchase_orders — Lấy danh sách phiếu nhập kèm tên nhà cung cấp
      if (pathname === '/api/purchase_orders' && request.method === 'GET') {
        const query = `
          SELECT 
            po.*,
            s.name as supplier_name
          FROM purchase_orders po
          LEFT JOIN suppliers s ON po.supplier_id = s.id
          ORDER BY po.id DESC
        `;
        const { results } = await db.prepare(query).all();
        return json(results || [], 200, origin);
      }

        // DELETE /api/purchase_orders/:id — Xóa phiếu nhập hàng (và hoàn trả tồn kho nếu cần)
      if (pathname.match(/^\/api\/purchase_orders\/\d+$/) && request.method === 'DELETE') {
        const id = pathname.split('/')[3];
        
        // Lấy chi tiết sản phẩm trong phiếu nhập để trừ lại tồn kho
        const itemsRes = await db.prepare('SELECT product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?').bind(id).all();
        const items = itemsRes.results || [];

        const stmts = [
          db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').bind(id),
          db.prepare('DELETE FROM purchase_orders WHERE id = ?').bind(id),
        ];

        // Hoàn lại kho sản phẩm khi xóa phiếu nhập
        for (const item of items) {
          stmts.push(
            db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(item.quantity, item.product_id)
          );
        }

        await db.batch(stmts);
        return json({ success: true }, 200, origin);
      }

        // GET /api/purchase_orders/:id — Lấy chi tiết phiếu nhập kèm danh sách sản phẩm
      if (pathname.match(/^\/api\/purchase_orders\/\d+$/) && request.method === 'GET') {
        const id = pathname.split('/')[3];
        const po = await db.prepare(`
          SELECT po.*, s.name as supplier_name 
          FROM purchase_orders po 
          LEFT JOIN suppliers s ON po.supplier_id = s.id 
          WHERE po.id = ?
        `).bind(id).first();

        if (!po) throw new HttpError(404, 'Không tìm thấy phiếu nhập');

        const itemsRes = await db.prepare(`
          SELECT poi.*, p.name as product_name, p.sku 
          FROM purchase_order_items poi 
          LEFT JOIN products p ON poi.product_id = p.id 
          WHERE poi.purchase_order_id = ?
        `).bind(id).all();

        return json({ ...po, items: itemsRes.results || [] }, 200, origin);
      }

        // GET /api/customers — Lấy danh sách khách hàng kèm tổng hợp Mua hàng, Thanh toán, Công nợ
      if (pathname === '/api/customers' && request.method === 'GET') {
        let results = [];
        try {
          // Thử lấy kèm thông tin tổng hợp nếu các bảng phụ đã tồn tại
          const query = `
            SELECT 
              c.*,
              COALESCE(i.total_purchased, 0) as total_purchased,
              COALESCE(pay.total_paid, 0) as total_paid,
              (COALESCE(i.total_purchased, 0) - COALESCE(pay.total_paid, 0)) as total_debt
            FROM customers c
            LEFT JOIN (
              SELECT customer_name, SUM(total) as total_purchased FROM invoices GROUP BY customer_name
            ) i ON c.name = i.customer_name
            LEFT JOIN (
              SELECT customer_name, SUM(amount) as total_paid FROM customer_payments GROUP BY customer_name
            ) pay ON c.name = pay.customer_name
            ORDER BY c.id DESC
          `;
          const res = await db.prepare(query).all();
          results = res.results || [];
        } catch (e) {
          // Nếu bảng phụ chưa có, fallback lấy danh sách trực tiếp từ bảng customers
          const res = await db.prepare('SELECT *, 0 as total_purchased, 0 as total_paid, 0 as total_debt FROM customers ORDER BY id DESC').all();
          results = res.results || [];
        }
        return json(results, 200, origin);
      }
      // POST /api/customers — Thêm mới khách hàng
      if (pathname === '/api/customers' && request.method === 'POST') {
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
        
        const code = String(b.code || '').trim() || genCode('KH');
        const phone = String(b.phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;

        await db.prepare('INSERT INTO customers (code, name, phone, address) VALUES (?, ?, ?, ?)')
          .bind(code, name, phone, address).run();
          
        return json({ success: true, code }, 201, origin);
      }

      // POST /api/customers/import — Nhập khẩu hàng loạt khách hàng
      if (pathname === '/api/customers/import' && request.method === 'POST') {
        const body = await request.json();
        const items = body.items || [];
        let successCount = 0;

        for (const item of items) {
          const name = String(item.name || '').trim();
          if (!name) continue;
          const code = String(item.code || '').trim() || genCode('KH');
          const phone = String(item.phone || '').trim() || null;
          const address = String(item.address || '').trim() || null;

          try {
            const existing = await db.prepare('SELECT id FROM customers WHERE code = ?').bind(code).first();
            if (existing) {
              await db.prepare('UPDATE customers SET name = ?, phone = ?, address = ? WHERE code = ?')
                .bind(name, phone, address, code).run();
            } else {
              await db.prepare('INSERT INTO customers (code, name, phone, address) VALUES (?, ?, ?, ?)')
                .bind(code, name, phone, address).run();
            }
            successCount++;
          } catch (e) {}
        }

        return json({ success: true, successCount }, 200, origin);
      }

        // GET /api/customers/:id/history — Lấy lịch sử đơn hàng và thanh toán của khách hàng
      if (pathname.match(/^\/api\/customers\/\d+\/history$/) && request.method === 'GET') {
        const id = pathname.split('/')[3];
        const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
        if (!customer) throw new HttpError(404, 'Không tìm thấy khách hàng');

        // Lấy danh sách đơn hàng/hóa đơn của khách hàng này
        const invoicesRes = await db.prepare(`
          SELECT * FROM invoices WHERE customer_name = ? ORDER BY id DESC
        `).bind(customer.name).all();

        // Lấy lịch sử thanh toán của khách hàng này
        const paymentsRes = await db.prepare(`
          SELECT * FROM customer_payments WHERE customer_name = ? ORDER BY id DESC
        `).bind(customer.name).all();

        return json({
          customer,
          invoices: invoicesRes.results || [],
          payments: paymentsRes.results || []
        }, 200, origin);
      }

      // DELETE /api/customers/:id — Xóa khách hàng
      if (pathname.match(/^\/api\/customers\/\d+$/) && request.method === 'DELETE') {
        const id = pathname.split('/')[3];
        await db.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // PUT /api/customers/:id — Cập nhật khách hàng
      if (pathname.match(/^\/api\/customers\/\d+$/) && request.method === 'PUT') {
        const id = pathname.split('/')[3];
        const b = await request.json();
        const code = String(b.code || '').trim();
        const name = String(b.name || '').trim();
        const phone = String(b.phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;

        await db.prepare('UPDATE customers SET code = ?, name = ?, phone = ?, address = ? WHERE id = ?')
          .bind(code, name, phone, address, id).run();

        return json({ success: true }, 200, origin);
      }

      // Phục vụ giao diện Frontend
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return json({ error: 'Không tìm thấy' }, 404, origin);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
      console.error(e);
      return json({ error: 'Lỗi chi tiết: ' + e.message }, 500, origin);
    }
  },
};
