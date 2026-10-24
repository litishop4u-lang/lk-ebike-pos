// Cloudflare Worker + D1 — API cho POS xe đạp điện (bản đã sửa lỗi)
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

// ===== Helpers =====
const genCode = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

// Sinh mã dạng PREFIX-MMYYNN: MM = tháng, YY = 2 số cuối năm (theo ngày lập phiếu), NN = số thứ tự trong tháng.
// Mỗi loại phiếu đếm riêng; qua 99 phiếu/tháng thì số thứ tự tự dài ra (BH-1026100).
async function nextCode(db, table, prefix, dateInput) {
  const m = /^(\d{4})-(\d{2})/.exec(String(dateInput || ''));
  const [y, mo] = m ? [m[1], m[2]] : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7).split('-');
  const head = `${prefix}-${mo}${y.slice(2)}`;
  const row = await db.prepare(
    `SELECT MAX(CAST(SUBSTR(code, ?) AS INTEGER)) AS m FROM ${table} WHERE code LIKE ?`
  ).bind(head.length + 1, head + '%').first();
  return head + String((Number(row?.m) || 0) + 1).padStart(2, '0');
}

const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, Number(v) || 0);
const isUnique = (e) => /UNIQUE/i.test(String(e?.message));
const placeholders = (arr) => arr.map(() => '?').join(',');
const isoDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};
const idOf = (pathname) => Number(pathname.split('/')[3]);
const dateOnly = (v) => String(v || '').slice(0, 10);
// Phiếu trả hàng đã hoàn thành (có cộng lại kho): "Hoàn Thành", "Đã hoàn thành", "Hoàn Thành (Cộng kho & trừ nợ)"
const isCompletedReturn = (s) => /hoàn thành/i.test(String(s || ''));
// Tách chuỗi "Số khung: A | Số sườn: B | Màu: C | Ghi chú: D" thành từng trường
const parseChassisText = (str0) => {
  const out = { chassis: '', frame: '', color: '', note: '' };
  String(str0 || '').split(' | ').forEach((part) => {
    const t = part.trim();
    if (!t) return;
    if (t.startsWith('Số khung:')) out.chassis = t.slice('Số khung:'.length).trim();
    else if (t.startsWith('Số sườn:')) out.frame = t.slice('Số sườn:'.length).trim();
    else if (t.startsWith('Màu:')) out.color = t.slice('Màu:'.length).trim();
    else if (t.startsWith('Ghi chú:')) out.note = t.slice('Ghi chú:'.length).trim();
  });
  return out;
};

// Chuẩn hóa để so sánh số khung / số sườn: in hoa, bỏ dấu cách, gạch ngang...
const normSerial = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Bảng ghi số khung / số sườn của từng xe lúc nhập hàng
let unitsReady = false;
async function ensureUnitSchema(db) {
  if (unitsReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS chassis_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    chassis TEXT,
    frame TEXT,
    purchase_order_id INTEGER,
    purchase_code TEXT,
    created_at TEXT
  )`).run();
  unitsReady = true;
}

// Lấy danh sách xe (số khung / số sườn) từ các dòng hàng client gửi lên. Mỗi dòng chỉ lấy tối đa "số lượng" xe.
function extractUnits(rawItems, lines) {
  const units = [];
  (Array.isArray(rawItems) ? rawItems : []).forEach((raw, i) => {
    const line = lines[i];
    if (!line || !raw || !Array.isArray(raw.serials)) return;
    raw.serials.slice(0, line.quantity).forEach((s) => {
      const chassis = str(s && s.chassis).toUpperCase().slice(0, 60);
      const frame = str(s && s.frame).toUpperCase().slice(0, 60);
      if (!chassis && !frame) return;
      units.push({ product_id: line.product_id, chassis, frame });
    });
  });
  return units;
}

// Không cho trùng số khung / số sườn (trong cùng phiếu, hoặc với phiếu nhập khác)
async function checkUnitsUnique(db, units, excludePurchaseId) {
  if (!units.length) return;
  const seen = new Set();
  for (const u of units) {
    for (const [label, v] of [['Số khung', u.chassis], ['Số sườn', u.frame]]) {
      const k = normSerial(v);
      if (!k) continue;
      const key = label + ':' + k;
      if (seen.has(key)) throw new HttpError(400, `${label} "${v}" bị nhập trùng trong phiếu này`);
      seen.add(key);
    }
  }
  const { results } = await db.prepare('SELECT chassis, frame, purchase_code, purchase_order_id FROM chassis_units').all();
  for (const r of results || []) {
    if (excludePurchaseId && Number(r.purchase_order_id) === Number(excludePurchaseId)) continue;
    const ck = normSerial(r.chassis);
    const fk = normSerial(r.frame);
    for (const u of units) {
      if (ck && ck === normSerial(u.chassis)) throw new HttpError(409, `Số khung "${u.chassis}" đã có ở phiếu nhập ${r.purchase_code}`);
      if (fk && fk === normSerial(u.frame)) throw new HttpError(409, `Số sườn "${u.frame}" đã có ở phiếu nhập ${r.purchase_code}`);
    }
  }
}

// Các câu lệnh ghi số khung / số sườn kèm mã phiếu nhập (đặt SAU câu lệnh tạo phiếu nhập trong cùng batch)
const unitStatements = (db, units, purchaseCode, createdAt) =>
  units.map((u) =>
    db.prepare('INSERT INTO chassis_units (product_id, chassis, frame, purchase_order_id, purchase_code, created_at) VALUES (?, ?, ?, (SELECT id FROM purchase_orders WHERE code = ?), ?, ?)')
      .bind(u.product_id, u.chassis, u.frame, purchaseCode, purchaseCode, createdAt));

// ===== Tính giá nhập: lưu trên D1 để dùng chung giữa máy tính và điện thoại =====
let costReady = false;
async function ensureCostSchema(db) {
  if (costReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS import_costs (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();
  costReady = true;
}
// Đơn đặt hàng chưa xuất bán
const isPendingStatus = (s) => !s || /pending|chờ|đang/i.test(String(s));

// Cột invoice_code trên bảng orders: nhớ đơn đặt hàng này đã xuất thành phiếu bán nào
let orderSchemaReady = false;
async function ensureOrderSchema(db) {
  if (orderSchemaReady) return;
  const { results } = await db.prepare('PRAGMA table_info(orders)').all();
  const cols = (results || []).map((c) => c.name);
  if (!cols.includes('invoice_code')) {
    await db.prepare('ALTER TABLE orders ADD COLUMN invoice_code TEXT').run();
  }
  if (!cols.includes('address')) {
    await db.prepare('ALTER TABLE orders ADD COLUMN address TEXT').run();
  }
  orderSchemaReady = true;
}

// ===== Gắn mã khách hàng (customer_code) vào chứng từ để không bị lẫn khách trùng tên =====
let customerCodeReady = false;
async function ensureCustomerCodes(db) {
  if (customerCodeReady) return;
  await ensureReturnSchema(db);
  // Thứ tự quan trọng: invoices trước, return_orders sau (phiếu trả mượn mã khách từ phiếu bán gốc)
  const targets = ['invoices', 'orders', 'return_orders'];
  if (await hasTable(db, 'customer_payments')) targets.push('customer_payments');

  // Chuẩn hóa SĐT: bỏ dấu cách và dấu chấm
  const ph = (x) => `REPLACE(REPLACE(COALESCE(${x}, ''), ' ', ''), '.', '')`;

  for (const t of targets) {
    const { results } = await db.prepare(`PRAGMA table_info(${t})`).all();
    const cols = (results || []).map((c) => c.name);
    if (!cols.includes('customer_code')) {
      await db.prepare(`ALTER TABLE ${t} ADD COLUMN customer_code TEXT`).run();
    }
    const blank = `(${t}.customer_code IS NULL OR ${t}.customer_code = '')`;

    // 1. Cùng tên + cùng số điện thoại
    if (cols.includes('customer_phone')) {
      await db.prepare(
        `UPDATE ${t} SET customer_code = (
           SELECT c.code FROM customers c
           WHERE c.name = ${t}.customer_name AND ${ph('c.phone')} <> '' AND ${ph('c.phone')} = ${ph(`${t}.customer_phone`)}
           ORDER BY c.id LIMIT 1)
         WHERE ${blank}`
      ).run();
    }

    // 2. Cùng tên + cùng địa chỉ
    if (cols.includes('address')) {
      await db.prepare(
        `UPDATE ${t} SET customer_code = (
           SELECT c.code FROM customers c
           WHERE c.name = ${t}.customer_name AND COALESCE(c.address, '') <> '' AND c.address = ${t}.address
           ORDER BY c.id LIMIT 1)
         WHERE ${blank}`
      ).run();
    }

    // 3. Phiếu trả hàng: lấy mã khách từ phiếu bán gốc
    if (t === 'return_orders') {
      await db.prepare(
        `UPDATE return_orders SET customer_code = (
           SELECT i.customer_code FROM invoices i WHERE i.code = return_orders.invoice_code AND COALESCE(i.customer_code, '') <> '')
         WHERE ${blank} AND COALESCE(invoice_code, '') <> ''`
      ).run();
    }

    // 4. Tên chỉ có DUY NHẤT 1 khách -> gán luôn
    await db.prepare(
      `UPDATE ${t} SET customer_code = (SELECT c.code FROM customers c WHERE c.name = ${t}.customer_name)
       WHERE ${blank} AND (SELECT COUNT(*) FROM customers c WHERE c.name = ${t}.customer_name) = 1`
    ).run();
    // Còn lại (tên trùng, không phân biệt được bằng SĐT/địa chỉ) -> để trống, chờ gán tay
  }
  customerCodeReady = true;
}

// Xác định khách hàng của phiếu bán / đơn đặt hàng:
//  - client gửi customer_code -> dùng đúng khách đó
//  - không gửi mã: tên chỉ khớp 1 khách -> dùng khách đó; trùng tên thì thử phân biệt bằng SĐT;
//    chưa có khách -> tạo mới; vẫn không phân biệt được -> báo lỗi bắt chọn
async function resolveCustomer(db, b) {
  const name = str(b.customer_name);
  if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const phone = str(b.customer_phone) || null;
  const address = str(b.address) || null;
  const code = str(b.customer_code);
  if (code) {
    const c = await db.prepare('SELECT code, name FROM customers WHERE code = ?').bind(code).first();
    if (!c) throw new HttpError(404, 'Khách hàng không tồn tại');
    return { code: c.code, name: c.name, phone, address, create: null };
  }
  const { results } = await db.prepare('SELECT code FROM customers WHERE name = ?').bind(name).all();
  const found = results || [];
  if (found.length === 1) return { code: found[0].code, name, phone, address, create: null };
  if (found.length > 1 && phone) {
    const byPhone = (await db.prepare('SELECT code FROM customers WHERE name = ? AND phone = ?').bind(name, phone).all()).results || [];
    if (byPhone.length === 1) return { code: byPhone[0].code, name, phone, address, create: null };
  }
    if (found.length > 1 && phone) {
    const byPhone = (await db.prepare('SELECT code FROM customers WHERE name = ? AND phone = ?').bind(name, phone).all()).results || [];
    if (byPhone.length === 1) return { code: byPhone[0].code, name, phone, address, create: null };
  }
  if (found.length > 1) {
    throw new HttpError(409, `Có ${found.length} khách hàng trùng tên "${name}". Vui lòng chọn đúng khách từ danh sách gợi ý.`);
  }
  const newCode = genCode('KH');
  return {
    code: newCode, name, phone, address,
    create: db.prepare('INSERT INTO customers (code, name, phone, address) VALUES (?,?,?,?)').bind(newCode, name, phone, address),
  };
}

// Phiếu trả hàng: tìm mã khách nhưng không tạo khách mới
async function lookupCustomerCode(db, code, name) {
  const c = str(code);
  if (c) return c;
  const { results } = await db.prepare('SELECT code FROM customers WHERE name = ?').bind(str(name)).all();
  return (results || []).length === 1 ? results[0].code : '';
}
// ===== Công nợ khách: tiền thu nợ nhập tay trong Thu chi =====
const normName = (v) => String(v ?? '').normalize('NFC').trim().toLowerCase();

// Tiền thu nợ nhập tay trong Thu chi, gom theo MÃ khách: Map(mã khách -> số tiền)
async function loadCollectionsByName(db) {
  const m = new Map();
  try {
    const { results } = await db.prepare(`
      SELECT reference_code AS code, SUM(amount) AS collected
      FROM cash_books
      WHERE type = 'IN' AND category = 'Bán hàng / Thu nợ KH'
        AND reference_code IN (SELECT code FROM customers)
      GROUP BY reference_code
    `).all();
    for (const r of results || []) m.set(r.code, Number(r.collected) || 0);
  } catch (e) { console.error('load collections failed', e); }
  return m;
}

// Phân bổ tiền thu nợ vào các phiếu còn nợ của đúng khách đó (phiếu cũ nhất trước).
// Chỉ để HIỂN THỊ: không sửa dữ liệu gốc trong bảng invoices.
function withCollected(invoices, collections) {
  const left = new Map(collections);
  const used = new Map();
  const baseDebt = (inv) =>
    inv.debt !== null && inv.debt !== undefined
      ? Number(inv.debt) || 0
      : (Number(inv.total) || 0) - (Number(inv.paid_amount) || 0);
  [...invoices]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || (a.id - b.id))
    .forEach((inv) => {
      const k = inv.customer_code || '';
      if (!k) return;
      const take = Math.min(Math.max(0, baseDebt(inv)), left.get(k) || 0);
      if (take > 0) {
        left.set(k, left.get(k) - take);
        used.set(inv.id, take);
      }
    });
  return invoices.map((inv) => {
    const take = used.get(inv.id) || 0;
    if (!take) return inv;
    return { ...inv, paid_amount: (Number(inv.paid_amount) || 0) + take, debt: baseDebt(inv) - take, collected: take };
  });
}

// Phiếu bán kèm số "đã thanh toán / còn nợ" sau khi trừ tiền thu nợ nhập trong Thu chi (cùng cách tính với danh sách)
async function adjustInvoice(db, inv) {
  if (!inv || !inv.customer_code) return inv;
  const same = (await db.prepare('SELECT * FROM invoices WHERE customer_code = ?').bind(inv.customer_code).all()).results || [];
  const adj = withCollected(same, await loadCollectionsByName(db)).find((x) => x.id === inv.id);
  return adj || inv;
}
// ===== Phiếu bảo hành (lưu trên D1 để dùng chung giữa máy tính và điện thoại) =====
let warrantyReady = false;
async function ensureWarrantySchema(db) {
  if (warrantyReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS warranties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    invoice_code TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    address TEXT,
    purchase_date TEXT,
    duration INTEGER,
    unit TEXT,
    expiry_date TEXT,
    note TEXT,
    items TEXT,
    created_at TEXT
  )`).run();
  warrantyReady = true;
}

const wRow = (r) => {
  let items = [];
  try { items = JSON.parse(r.items || '[]'); } catch (e) { /* bỏ qua */ }
  return { ...r, items: Array.isArray(items) ? items : [] };
};

// Kiểm tra dữ liệu và trả về mảng giá trị theo đúng thứ tự cột
const warrantyFields = (b) => {
  const code = str(b.code);
  const customer_name = str(b.customer_name);
  if (!code) throw new HttpError(400, 'Thiếu mã phiếu bảo hành');
  if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
  return [
    code, str(b.invoice_code), customer_name, str(b.customer_phone), str(b.address),
    str(b.purchase_date), Number(b.duration) || 0, str(b.unit) || 'month', str(b.expiry_date), str(b.note),
    JSON.stringify(Array.isArray(b.items) ? b.items : []),
  ];
};

async function hasTable(db, name) {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first());
}

// Bảng chi tiết phiếu trả hàng (return_order_items): lưu sản phẩm nào, số lượng bao nhiêu để
// báo cáo Xuất - Nhập - Tồn, thẻ kho và giá vốn tính đúng.
// Lần đầu tạo bảng sẽ tự bổ sung chi tiết cho các phiếu trả CŨ (chưa có chi tiết) nếu số tiền hoàn
// đúng bằng tổng phiếu bán gốc (tức là trả toàn bộ phiếu).
let returnSchemaReady = false;
async function ensureReturnSchema(db) {
  if (returnSchemaReady) return;
  const existed = await hasTable(db, 'return_order_items');
  if (!existed) {
    await db.prepare(`CREATE TABLE IF NOT EXISTS return_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0
    )`).run();
    try {
      await db.prepare(`
        INSERT INTO return_order_items (return_order_id, product_id, quantity, price, total)
        SELECT r.id, ii.product_id, ii.quantity,
               CASE WHEN ii.quantity > 0 THEN ROUND(ii.total * 1.0 / ii.quantity) ELSE 0 END,
               ii.total
        FROM return_orders r
        JOIN invoices inv ON inv.code = r.invoice_code
        JOIN invoice_items ii ON ii.invoice_id = inv.id
        WHERE r.invoice_code IS NOT NULL AND r.invoice_code <> ''
          AND ABS(COALESCE(r.refund_amount, 0) - COALESCE(inv.total, 0)) <= 10
          AND NOT EXISTS (SELECT 1 FROM return_order_items x WHERE x.return_order_id = r.id)
      `).run();
    } catch (e) {
      console.error('backfill return items failed', e);
    }
  }
    // Cột total_amount = tổng giá trị hàng trả (khác refund_amount là số tiền mặt đã hoàn cho khách)
  const { results: roCols } = await db.prepare('PRAGMA table_info(return_orders)').all();
  if (!(roCols || []).some((c) => c.name === 'total_amount')) {
    await db.prepare('ALTER TABLE return_orders ADD COLUMN total_amount REAL NOT NULL DEFAULT 0').run();
    // Phiếu cũ: lấy tổng từ chi tiết sản phẩm, phiếu nào chưa có chi tiết thì lấy theo tiền hoàn
    await db.prepare(`UPDATE return_orders SET total_amount = COALESCE(
      (SELECT SUM(total) FROM return_order_items WHERE return_order_id = return_orders.id), 0)`).run();
    await db.prepare('UPDATE return_orders SET total_amount = refund_amount WHERE total_amount = 0').run();
  }
  returnSchemaReady = true;
}

// Tự thêm cột chassis_color (lưu số khung/sườn/màu/ghi chú) nếu bảng chưa có
let chassisReady = false;
async function ensureChassisColumns(db) {
  if (chassisReady) return;
  for (const t of ['invoice_items', 'order_items']) {
    const { results } = await db.prepare(`PRAGMA table_info(${t})`).all();
    if (!(results || []).some((c) => c.name === 'chassis_color')) {
      await db.prepare(`ALTER TABLE ${t} ADD COLUMN chassis_color TEXT`).run();
    }
  }
  chassisReady = true;
}

// Lấy toàn bộ dòng hàng trả lại của các phiếu trả ĐÃ HOÀN THÀNH (đã cộng lại kho)
async function loadReturnLines(db) {
  await ensureReturnSchema(db);
  const { results } = await db.prepare(`
    SELECT roi.product_id, roi.quantity, roi.total, ro.return_date, ro.created_at, ro.status
    FROM return_order_items roi
    JOIN return_orders ro ON roi.return_order_id = ro.id
  `).all();
  return (results || [])
    .filter((r) => isCompletedReturn(r.status))
    .map((r) => ({
      product_id: r.product_id,
      quantity: Number(r.quantity) || 0,
      total: Number(r.total) || 0,
      date: dateOnly(r.return_date || r.created_at),
    }));
}

// ===== Trả hàng nhập (trả hàng lại cho NCC) =====
let purchaseReturnReady = false;
async function ensurePurchaseReturnSchema(db) {
  if (purchaseReturnReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS purchase_return_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    purchase_code TEXT,
    supplier_id INTEGER,
    supplier_name TEXT,
    return_date TEXT,
    reason TEXT,
    total_amount REAL NOT NULL DEFAULT 0,
    received_amount REAL NOT NULL DEFAULT 0,
    payment_method TEXT,
    status TEXT,
    created_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS purchase_return_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0
  )`).run();
  // [FIX] Bảng cũ chưa có cột "đã thu lại tiền hoàn từ NCC" -> tự bổ sung
  const { results } = await db.prepare('PRAGMA table_info(purchase_return_orders)').all();
  const cols = (results || []).map((c) => c.name);
  if (!cols.includes('received_amount'))
    await db.prepare('ALTER TABLE purchase_return_orders ADD COLUMN received_amount REAL NOT NULL DEFAULT 0').run();
  if (!cols.includes('payment_method'))
    await db.prepare('ALTER TABLE purchase_return_orders ADD COLUMN payment_method TEXT').run();
  purchaseReturnReady = true;
}

// Các dòng hàng đã trả NCC (chỉ phiếu đã hoàn thành mới trừ kho)
async function loadPurchaseReturnLines(db) {
  await ensurePurchaseReturnSchema(db);
  const { results } = await db.prepare(`
    SELECT i.product_id, i.quantity, i.total, r.return_date, r.created_at, r.status
    FROM purchase_return_order_items i
    JOIN purchase_return_orders r ON i.return_id = r.id
  `).all();
  return (results || [])
    .filter((r) => isCompletedReturn(r.status))
    .map((r) => ({
      product_id: r.product_id,
      quantity: Number(r.quantity) || 0,
      total: Number(r.total) || 0,
      date: dateOnly(r.return_date || r.created_at),
    }));
}

const groupByProduct = (arr) => {
  const m = new Map();
  for (const x of arr) {
    const k = String(x.product_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

// ===== [MỚI] TÍNH XUẤT - NHẬP - TỒN THEO BÌNH QUÂN GIA QUYỀN CUỐI KỲ =====
// Dùng chung cho báo cáo Xuất Nhập Tồn và báo cáo Kết quả kinh doanh để giá vốn luôn khớp nhau.
//
//  - Giá trị tồn đầu  = SL tồn đầu × giá bình quân các lần nhập TRƯỚC kỳ (chưa có thì dùng giá nhập trên thẻ SP)
//  - Đơn giá bình quân kỳ = (Giá trị tồn đầu + Giá trị nhập NCC trong kỳ − Giá trị trả NCC)
//                           ÷ (SL tồn đầu + SL nhập NCC trong kỳ − SL trả NCC)
//  - Giá trị xuất     = SL bán × đơn giá bình quân kỳ + giá trị hàng trả NCC
//  - Giá trị nhập     = Giá trị nhập NCC + SL khách trả lại × đơn giá bình quân kỳ
//  - Giá trị tồn cuối = Tồn đầu + Nhập − Xuất  (luôn khớp công thức, = SL tồn cuối × đơn giá bình quân)
async function buildInventoryReport(db, startDate, endDate) {
  const cleanStart = dateOnly(startDate);
  const cleanEnd = dateOnly(endDate);
  const n0 = (v) => Number(v) || 0;

  const prodRes = await db.prepare('SELECT * FROM products').all();
  const products = prodRes.results || [];

  const purchaseRes = await db.prepare(`
    SELECT poi.product_id, poi.quantity, poi.total, po.created_at
    FROM purchase_order_items poi
    JOIN purchase_orders po ON poi.purchase_order_id = po.id
  `).all();
  const purchaseMap = groupByProduct((purchaseRes.results || []).map((i) => ({ ...i, date: dateOnly(i.created_at) })));

  const invoiceRes = await db.prepare(`
    SELECT ii.product_id, ii.quantity, inv.created_at
    FROM invoice_items ii
    JOIN invoices inv ON ii.invoice_id = inv.id
  `).all();
  const invoiceMap = groupByProduct((invoiceRes.results || []).map((i) => ({ ...i, date: dateOnly(i.created_at) })));

  const returnMap = groupByProduct(await loadReturnLines(db));          // khách trả hàng (đã cộng lại kho)
  const supRetMap = groupByProduct(await loadPurchaseReturnLines(db));  // trả hàng NCC (đã trừ kho)

  return products.map((p) => {
    const key = String(p.id);
    const pPur = purchaseMap.get(key) || [];
    const pInv = invoiceMap.get(key) || [];
    const pRet = returnMap.get(key) || [];
    const pSup = supRetMap.get(key) || [];

    const currentStock = n0(p.stock);
    const fallbackCost = n0(p.import_price ?? p.cost_price);
    const prodCode = String(p.sku || p.code || p.product_code || '---');
    const prodName = String(p.name || p.product_name || 'Không tên');
    const prodUnit = String(p.unit || 'Cái');

    // Giá bình quân các lần nhập TRƯỚC kỳ -> dùng định giá tồn đầu kỳ
    let priorQty = 0, priorVal = 0;
    for (const i of pPur) {
      if (i.date && i.date < cleanStart) { priorQty += n0(i.quantity); priorVal += n0(i.total); }
    }
    const openingUnitCost = priorQty > 0 && priorVal > 0 ? priorVal / priorQty : fallbackCost;

    // Nhập từ NCC: trong kỳ và sau kỳ
    let purQty = 0, purVal = 0, purAfterQty = 0;
    for (const i of pPur) {
      const q = n0(i.quantity);
      if (!i.date || (i.date >= cleanStart && i.date <= cleanEnd)) {
        purQty += q;
        purVal += n0(i.total) || q * openingUnitCost;
      } else if (i.date > cleanEnd) {
        purAfterQty += q;
      }
    }

    // Khách trả hàng: trong kỳ và sau kỳ
    let retQty = 0, retAfterQty = 0;
    for (const r of pRet) {
      if (r.date >= cleanStart && r.date <= cleanEnd) retQty += n0(r.quantity);
      else if (r.date > cleanEnd) retAfterQty += n0(r.quantity);
    }

    // Xuất bán: trong kỳ và sau kỳ
    let expQty = 0, expAfterQty = 0;
    for (const i of pInv) {
      if (!i.date) continue;
      if (i.date >= cleanStart && i.date <= cleanEnd) expQty += n0(i.quantity);
      else if (i.date > cleanEnd) expAfterQty += n0(i.quantity);
    }

    // Trả hàng cho NCC: trong kỳ và sau kỳ
    let supQty = 0, supVal = 0, supAfterQty = 0;
    for (const r of pSup) {
      if (r.date >= cleanStart && r.date <= cleanEnd) {
        const q = n0(r.quantity);
        supQty += q;
        supVal += n0(r.total) || q * openingUnitCost;
      } else if (r.date > cleanEnd) supAfterQty += n0(r.quantity);
    }

    // Số lượng
    const closingQty = currentStock + expAfterQty - purAfterQty - retAfterQty + supAfterQty;
    const importQty = purQty + retQty;
    const exportQty = expQty + supQty;
    const openingQty = closingQty - importQty + exportQty;

    // Giá trị tồn đầu kỳ
    const openingValRaw = Math.max(0, openingQty) * openingUnitCost;

    // Đơn giá bình quân gia quyền cuối kỳ
    const poolQty = Math.max(0, openingQty) + purQty - supQty;
    const poolVal = openingValRaw + purVal - supVal;
    let avgCost;
    if (poolQty > 0 && poolVal > 0) avgCost = poolVal / poolQty;
    else if (purQty > 0 && purVal > 0) avgCost = purVal / purQty;
    else avgCost = openingUnitCost;

    // Giá trị (làm tròn từng khoản rồi suy ra tồn cuối để cộng trừ luôn khớp)
    const openingVal = Math.round(openingValRaw);
    const importVal = Math.round(purVal + retQty * avgCost);
    const exportVal = Math.round(expQty * avgCost + supVal);
    const closingVal = closingQty === 0 ? 0 : openingVal + importVal - exportVal;

    return {
      id: p.id,
      code: prodCode,
      name: prodName,
      unit: prodUnit,
      openingQty,
      openingVal,
      importQty,
      importVal,
      exportQty,
      exportVal,
      closingQty,
      closingVal,
      // Thông tin phụ cho báo cáo lãi lỗ
      avgCost,
      soldQty: expQty,
      returnedQty: retQty,
    };
  });
}

// Chuẩn hoá & kiểm tra dòng hàng từ client
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Danh sách sản phẩm trống');
  return items.map((it) => {
    const product_id = Number(it.product_id);
    const quantity = Number(it.quantity);
    if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity <= 0)
      throw new HttpError(400, 'Sản phẩm hoặc số lượng không hợp lệ');
    const price = money(it.price);
    const discount = money(it.discount);
    const gross = quantity * price;
    if (discount > gross) throw new HttpError(400, 'Giảm giá không được lớn hơn thành tiền');
    return { product_id, quantity, price, discount, total: gross - discount, chassis_color: str(it.chassis_color) };
  });
}
const sumTotal = (lines) => lines.reduce((s, l) => s + l.total, 0);

// [MỚI] Chuẩn hoá dòng hàng của phiếu trả hàng (bán + nhập)
const normalizeReturnLines = (items) =>
  (Array.isArray(items) ? items : [])
    .map((it) => ({ product_id: Number(it.product_id), quantity: Number(it.quantity), price: money(it.price) }))
    .filter((l) => Number.isInteger(l.product_id) && Number.isInteger(l.quantity) && l.quantity > 0);

// Kiểm tra sản phẩm tồn tại (và đủ tồn kho nếu cần). Trả về danh sách id duy nhất.
async function loadProducts(db, lines, { checkStock }) {
  const need = new Map();
  for (const l of lines) need.set(l.product_id, (need.get(l.product_id) || 0) + l.quantity);
  const ids = [...need.keys()];
  const { results } = await db
    .prepare(`SELECT id, name, stock FROM products WHERE id IN (${placeholders(ids)})`)
    .bind(...ids).all();
  if (results.length !== ids.length) throw new HttpError(404, 'Có sản phẩm không tồn tại');
  if (checkStock) {
    for (const p of results) {
      if ((p.stock || 0) < need.get(p.id))
        throw new HttpError(409, `Sản phẩm "${p.name}" chỉ còn ${p.stock || 0} trong kho, không đủ bán!`);
    }
  }
  return ids;
}

// Statement "chốt chặn": nếu sau khi trừ/cộng kho mà có sản phẩm bị âm -> json() báo lỗi
// "malformed JSON" -> toàn bộ db.batch() bị rollback. Đảm bảo không bán lố kể cả khi 2 người bán cùng lúc.
const stockGuard = (db, ids) =>
  db.prepare(
    `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM products WHERE id IN (${placeholders(ids)}) AND stock < 0) THEN 'ROLLBACK' ELSE '{}' END)`
  ).bind(...ids);

async function runBatch(db, stmts, stockMsg) {
  try {
    return await db.batch(stmts);
  } catch (e) {
    if (/malformed JSON|CHECK constraint failed/i.test(String(e?.message))) throw new HttpError(409, stockMsg);
    throw e;
  }
}

// Import hàng loạt: gom theo lô thay vì await từng dòng
async function runImport(db, stmts, size = 50) {
  let successCount = 0, errorCount = 0;
  for (let i = 0; i < stmts.length; i += size) {
    const chunk = stmts.slice(i, i + size);
    try { await db.batch(chunk); successCount += chunk.length; }
    catch (e) { errorCount += chunk.length; }
  }
  return { successCount, errorCount };
}

// Tự tạo khách hàng nếu tên chưa có trong danh sách (để công nợ/lịch sử khớp)
const ensureCustomer = (db, name, phone, address) =>
  db.prepare('INSERT INTO customers (code, name, phone, address) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = ?)')
    .bind(genCode('KH'), name, phone, address, name);

// ===== Nghiệp vụ =====
async function createInvoice(db, b) {
  const cus = await resolveCustomer(db, b);

  const lines = normalizeItems(b.items);
  const ids = await loadProducts(db, lines, { checkStock: true });

  const total = sumTotal(lines);
  const paid_amount = Math.min(money(b.paid_amount), total);
  const debt = total - paid_amount;
  const created_at = isoDate(b.created_at);
  const code = await nextCode(db, 'invoices', 'BH', created_at);
  const payment_method = str(b.payment_method) || 'Tiền mặt';

  const stmts = [
    ...(cus.create ? [cus.create] : []),
    db.prepare('INSERT INTO invoices (code, customer_name, customer_phone, address, total, paid_amount, debt, created_at, payment_method, customer_code) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(code, cus.name, cus.phone, cus.address, total, paid_amount, debt, created_at, payment_method, cus.code),
    ...lines.map((l) =>
      // Bảng invoice_items có cột unit_price (NOT NULL) nên ghi thêm cả unit_price lẫn price
      db.prepare('INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, price, discount, total, chassis_color) VALUES ((SELECT id FROM invoices WHERE code = ?),?,?,?,?,?,?,?)')
        .bind(code, l.product_id, l.quantity, l.price, l.price, l.discount, l.total, l.chassis_color)),
    ...lines.map((l) =>
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)),
    stockGuard(db, ids),
  ];
  await runBatch(db, stmts, 'Tồn kho vừa thay đổi, không đủ hàng. Vui lòng tải lại và thử lại');
  return { code, total };
}

async function createOrder(db, b) {
  const cus = await resolveCustomer(db, b);

  const lines = normalizeItems(b.items);
  await loadProducts(db, lines, { checkStock: false }); // đơn đặt hàng: không trừ kho

  const total = sumTotal(lines);
  const paid = Math.min(money(b.paid_amount), total);
  const created_at = isoDate(b.created_at);
  const code = await nextCode(db, 'orders', 'DH', created_at);
  const paymentMethod = str(b.payment_method) || 'Tiền mặt';

  const stmts = [
    ...(cus.create ? [cus.create] : []),
      db.prepare('INSERT INTO orders (code, customer_name, customer_phone, address, total, paid_amount, debt, payment_method, created_at, status, customer_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(code, cus.name, cus.phone, cus.address, total, paid, total - paid, paymentMethod, created_at, 'Pending', cus.code),
    ...lines.map((l) =>
      db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price, discount, total, chassis_color) VALUES ((SELECT id FROM orders WHERE code = ?),?,?,?,?,?,?)')
        .bind(code, l.product_id, l.quantity, l.price, l.discount, l.total, l.chassis_color)),
  ];
  // Có tạm ứng -> ghi ngay 1 phiếu thu vào Sổ quỹ (chứng từ = mã đơn đặt hàng)
  if (paid > 0) {
    stmts.push(
      db.prepare(`
        INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
        VALUES (?, 'IN', ?, 'Bán hàng / Thu nợ KH', ?, ?, ?, ?)
      `).bind(
        await nextCode(db, 'cash_books', 'PT', created_at),
        paid,
        paymentMethod,
        code,
        `Tạm ứng đơn đặt hàng ${code} của khách ${cus.name}`,
        created_at
      )
    );
  }
  await db.batch(stmts);
  return { code, total };
}

// Dựng các statement cho 1 phiếu nhập (dùng chung cho POST và PUT)
async function buildPurchase(db, b) {
  const supplier_id = Number(b.supplier_id);
  if (!supplier_id) throw new HttpError(400, 'Vui lòng chọn nhà cung cấp');
  if (!(await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(supplier_id).first()))
    throw new HttpError(404, 'Nhà cung cấp không tồn tại');
  const lines = normalizeItems(b.items);
  const ids = await loadProducts(db, lines, { checkStock: false });
  const total = sumTotal(lines);
  const paid_amount = Math.min(money(b.paid_amount), total);
  return {
    supplier_id, lines, ids, total, paid_amount,
    debt: total - paid_amount,
    payment_method: str(b.payment_method) || 'Tiền mặt',
    units: extractUnits(b.items, lines),
  };
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const { pathname } = new URL(request.url);
    const method = request.method;
    const db = env.DB;
    const is = (re, m) => re.test(pathname) && method === m;

    if (method === 'OPTIONS') return json(null, 204, origin);

    try {
      if (pathname.startsWith('/api/')) await ensureCustomerCodes(db);
      if (pathname.startsWith('/api/purchase_orders')) await ensureUnitSchema(db);
      // Đảm bảo bảng có cột chassis_color trước khi thao tác phiếu bán / đơn đặt hàng
      if (pathname.startsWith('/api/invoices') || pathname.startsWith('/api/orders')) {
        await ensureChassisColumns(db);
        await ensureOrderSchema(db);
      }

      // ===== 1. SẢN PHẨM =====
      if (pathname === '/api/products' && method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM products ORDER BY id DESC').all();
        return json((results || []).map((p) => ({
          id: p.id,
          sku: p.sku || p.code || '',
          name: p.name || '',
          unit: p.unit || 'Cái',
          import_price: p.import_price || p.cost_price || 0,
          price: p.price || p.retail_price || 0,
          wholesale_price: p.wholesale_price || 0,
          stock: p.stock || p.quantity || 0,
        })), 200, origin);
      }

      if (pathname === '/api/products' && method === 'POST') {
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên sản phẩm');
        try {
          await db.prepare('INSERT INTO products (sku, name, unit, import_price, price, wholesale_price, stock) VALUES (?,?,?,?,?,?,?)')
            .bind(str(b.sku) || genCode('SP'), name, str(b.unit) || 'Cái', money(b.import_price), money(b.price), money(b.wholesale_price), money(b.stock)).run();
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã SKU sản phẩm');
          throw err;
        }
        return json({ success: true }, 201, origin);
      }

      if (pathname === '/api/products/import' && method === 'POST') {
        const { items = [] } = await request.json();
        const bySku = new Map(); // gộp trùng SKU trong cùng file (dòng sau đè dòng trước)
        let invalid = 0;
        for (const it of items) {
          const name = str(it.name);
          if (!name) { invalid++; continue; }
          const sku = str(it.sku) || genCode('SP');
          bySku.set(sku, { sku, name, unit: str(it.unit) || 'Cái', import_price: money(it.import_price), price: money(it.price), wholesale_price: money(it.wholesale_price), stock: money(it.stock) });
        }
        const stmts = [...bySku.values()].map((p) =>
          db.prepare(`INSERT INTO products (sku, name, unit, import_price, price, wholesale_price, stock) VALUES (?,?,?,?,?,?,?)
                      ON CONFLICT(sku) DO UPDATE SET name = excluded.name, unit = excluded.unit, import_price = excluded.import_price,
                      price = excluded.price, wholesale_price = excluded.wholesale_price, stock = excluded.stock`)
            .bind(p.sku, p.name, p.unit, p.import_price, p.price, p.wholesale_price, p.stock));
        const r = await runImport(db, stmts);
        return json({ success: true, successCount: r.successCount, errorCount: r.errorCount + invalid }, 200, origin);
      }

      if (is(/^\/api\/products\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên sản phẩm');
        try {
          const r = await db.prepare('UPDATE products SET sku = ?, name = ?, unit = ?, import_price = ?, price = ?, wholesale_price = ?, stock = ? WHERE id = ?')
            .bind(str(b.sku) || `SP-${id}`, name, str(b.unit) || 'Cái', money(b.import_price), money(b.price), money(b.wholesale_price), money(b.stock), id).run();
          if (!r.meta?.changes) throw new HttpError(404, 'Không tìm thấy sản phẩm');
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã SKU sản phẩm');
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/products\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const used = await db.prepare(
          `SELECT (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?1)
                + (SELECT COUNT(*) FROM order_items WHERE product_id = ?1)
                + (SELECT COUNT(*) FROM purchase_order_items WHERE product_id = ?1) AS n`
        ).bind(id).first();
        if (used?.n > 0) throw new HttpError(409, 'Sản phẩm đã phát sinh giao dịch nên không thể xóa');
        await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // ===== API THẺ KHO CHI TIẾT SẢN PHẨM =====
      if (pathname === '/api/products/stock-card' && method === 'GET') {
        await ensureReturnSchema(db);
        const urlObj = new URL(request.url);
        const productId = urlObj.searchParams.get('productId');

        // 1. Lấy lịch sử Nhập hàng
        const importsRes = await db.prepare(`
          SELECT po.code as purchase_code, po.created_at, sup.name as partner_name, poi.price, poi.quantity
          FROM purchase_order_items poi
          JOIN purchase_orders po ON poi.purchase_order_id = po.id
          LEFT JOIN suppliers sup ON po.supplier_id = sup.id
          WHERE poi.product_id = ?
        `).bind(productId).all();

        // 2. Lấy lịch sử Bán hàng (Xuất kho)
        const exportsRes = await db.prepare(`
          SELECT i.code as invoice_code, i.created_at, i.customer_name as partner_name, ii.price, ii.quantity
          FROM invoice_items ii
          JOIN invoices i ON ii.invoice_id = i.id
          WHERE ii.product_id = ?
        `).bind(productId).all();

        // 3. Lấy lịch sử Khách trả hàng (Nhập lại kho)
        const returnsRes = await db.prepare(`
          SELECT ro.code as return_code, COALESCE(ro.return_date, ro.created_at) as created_at,
                 ro.customer_name as partner_name, ro.status, roi.price, roi.quantity
          FROM return_order_items roi
          JOIN return_orders ro ON roi.return_order_id = ro.id
          WHERE roi.product_id = ?
        `).bind(productId).all();

        let transactions = [];

        // Đưa phiếu nhập vào (Số lượng dương)
        (importsRes.results || []).forEach(item => {
          transactions.push({
            code: item.purchase_code || ('NK-' + item.id),
            date: item.created_at,
            partner: item.partner_name || 'Nhà cung cấp',
            import_price: Number(item.price) || 0,
            export_price: 0,
            qty: Number(item.quantity) || 0
          });
        });

        // Đưa phiếu xuất/bán vào (Số lượng âm)
        (exportsRes.results || []).forEach(item => {
          transactions.push({
            code: item.invoice_code || ('HD-' + item.id),
            date: item.created_at,
            partner: item.partner_name || 'Khách lẻ',
            import_price: 0,
            export_price: Number(item.price) || 0,
            qty: -(Number(item.quantity) || 0)
          });
        });

        // Đưa phiếu khách trả hàng vào (Số lượng dương, chỉ phiếu đã hoàn thành mới cộng kho)
        (returnsRes.results || []).forEach(item => {
          if (!isCompletedReturn(item.status)) return;
          transactions.push({
            code: item.return_code || 'TH',
            date: item.created_at,
            partner: item.partner_name || 'Khách lẻ',
            import_price: 0,
            export_price: Number(item.price) || 0,
            qty: Number(item.quantity) || 0
          });
        });

        // Trả hàng cho NCC (xuất khỏi kho, số lượng âm)
        await ensurePurchaseReturnSchema(db);
        const supRetRes = await db.prepare(`
          SELECT r.code, COALESCE(r.return_date, r.created_at) AS created_at, r.supplier_name, r.status, i.price, i.quantity
          FROM purchase_return_order_items i
          JOIN purchase_return_orders r ON i.return_id = r.id
          WHERE i.product_id = ?
        `).bind(productId).all();
        (supRetRes.results || []).forEach((item) => {
          if (!isCompletedReturn(item.status)) return;
          transactions.push({
            code: item.code,
            date: item.created_at,
            partner: item.supplier_name || 'Nhà cung cấp',
            import_price: Number(item.price) || 0,
            export_price: 0,
            qty: -(Number(item.quantity) || 0)
          });
        });

        // Sắp xếp theo thời gian tăng dần để tính lũy kế chính xác
        transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

        let runningStock = 0;
        const stockCard = transactions.map(tx => {
          runningStock += tx.qty;
          return {
            ...tx,
            running_stock: runningStock
          };
        });

        return json({ success: true, data: stockCard }, 200, origin);
      }

      // ===== 2. PHIẾU BÁN HÀNG / ĐƠN ĐẶT HÀNG =====
            if (pathname === '/api/invoices' && method === 'POST') {
        const payload = await request.json();
        const r = await createInvoice(db, payload);

        // Phiếu bán tạo từ đơn đặt hàng: đơn chuyển "Hoàn thành" (vẫn giữ trong danh sách) và nhớ phiếu bán đã xuất
        let depositRecorded = 0;
        const fromOrderId = Number(payload.from_order_id);
        if (Number.isInteger(fromOrderId) && fromOrderId > 0) {
          const ord = await db.prepare('SELECT code FROM orders WHERE id = ?').bind(fromOrderId).first();
          if (ord) {
            const dep = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM cash_books WHERE type = 'IN' AND reference_code = ?").bind(ord.code).first();
            depositRecorded = Number(dep?.s) || 0; // tạm ứng đã có phiếu thu riêng từ lúc tạo đơn
            await db.prepare("UPDATE orders SET status = 'Hoàn thành', invoice_code = ? WHERE id = ?").bind(r.code, fromOrderId).run();
          }
        }

        // Phiếu thu tự sinh chỉ ghi phần CHƯA được ghi nhận
        const paidAmount = Math.min(money(payload.paid_amount), r.total);
        const cashAmount = Math.max(0, paidAmount - depositRecorded);
        if (cashAmount > 0 && r.code) {
          const cashCode = await nextCode(db, 'cash_books', 'PT', payload.created_at);
          const customerName = payload.customer_name || 'Khách hàng';
          const paymentMethod = payload.payment_method || 'Chuyển khoản';
          const noteText = depositRecorded > 0
            ? `Thu thêm tiền bán hàng từ khách ${customerName} theo hóa đơn ${r.code} (đã trừ tạm ứng ${depositRecorded.toLocaleString('vi-VN')})`
            : `Thu tiền bán hàng từ khách ${customerName} theo hóa đơn ${r.code}`;
          const customDate = payload.created_at || new Date().toISOString();

          await db.prepare(`
            INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
            VALUES (?, 'IN', ?, 'Bán hàng / Thu nợ KH', ?, ?, ?, ?)
          `).bind(cashCode, cashAmount, paymentMethod, r.code, noteText, customDate).run();
        }

        return json({ success: true, ...r }, 201, origin);
      }

      if (pathname === '/api/orders' && method === 'POST') {
        const r = await createOrder(db, await request.json());
        return json({ success: true, ...r }, 201, origin);
      }

      // GET /api/invoices — Lấy danh sách phiếu bán hàng (đã trừ tiền thu nợ nhập trong Thu chi)
      if (pathname === '/api/invoices' && request.method === 'GET') {
        const res = await db.prepare('SELECT * FROM invoices ORDER BY id DESC').all();
        return json(withCollected(res.results || [], await loadCollectionsByName(db)), 200, origin);
      }

            // GET /api/orders — Lấy danh sách đơn đặt hàng
      // Đơn đã "Hoàn thành": công nợ lấy theo phiếu bán đã xuất (đã trừ tiền thu nợ trong Thu chi)
      if (pathname === '/api/orders' && request.method === 'GET') {
        const orders = (await db.prepare('SELECT * FROM orders ORDER BY id DESC').all()).results || [];
        const invs = withCollected((await db.prepare('SELECT * FROM invoices').all()).results || [], await loadCollectionsByName(db));
        const byCode = new Map(invs.map((i) => [i.code, i]));
        const claimed = new Set(orders.map((o) => o.invoice_code).filter(Boolean));

        return json(orders.map((o) => {
          if (isPendingStatus(o.status)) return o;
          let inv = o.invoice_code ? byCode.get(o.invoice_code) : null;
          if (!inv) {
            // Đơn cũ chưa có liên kết: ghép theo cùng khách + cùng tổng tiền
            inv = invs.find((i) =>
              !claimed.has(i.code) &&
              (i.customer_code || '') === (o.customer_code || '') &&
              Math.abs((Number(i.total) || 0) - (Number(o.total) || 0)) <= 10);
            if (inv) claimed.add(inv.code);
          }
          if (!inv) return o;
          return { ...o, invoice_code: inv.code, debt: Math.max(0, Number(inv.debt) || 0) };
        }), 200, origin);
      }

      // PUT /api/orders/:id — Cập nhật đơn đặt hàng
      if (pathname.match(/^\/api\/orders\/\d+$/) && request.method === 'PUT') {
        const id = pathname.split('/')[3];
        const b = await request.json();
        const cus = await resolveCustomer(db, b);
        const customer_name = cus.name;
        const customer_phone = cus.phone;
        const address = cus.address;
        const created_at = b.created_at || new Date().toISOString();
        const items = b.items || [];
        const paid_amount = Number(b.paid_amount) || 0;
        const payment_method = b.payment_method || 'Tiền mặt';

        if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
        if (items.length === 0) throw new HttpError(400, 'Giỏ hàng trống');
        const oldOrder = await db.prepare('SELECT code FROM orders WHERE id = ?').bind(id).first();
        if (!oldOrder) throw new HttpError(404, 'Không tìm thấy đơn đặt hàng');

        let total = 0;
        for (const item of items) {
          total += (item.quantity * item.price) - (item.discount || 0);
        }
        const debt = total - paid_amount;

        const stmts = [
          ...(cus.create ? [cus.create] : []),
          db.prepare('UPDATE orders SET customer_name = ?, customer_phone = ?, address = ?, total = ?, paid_amount = ?, debt = ?, payment_method = ?, created_at = ?, customer_code = ? WHERE id = ?')
            .bind(customer_name, customer_phone, address, total, paid_amount, debt, payment_method, created_at, cus.code, id),
          db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id)
        ];

        for (const item of items) {
          const lineTotal = (item.quantity * item.price) - (item.discount || 0);
          stmts.push(
            db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price, discount, total, chassis_color) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(id, item.product_id, item.quantity, item.price, item.discount || 0, lineTotal, str(item.chassis_color))
          );
        }

                // Đồng bộ Sổ quỹ: xóa phiếu thu tạm ứng cũ rồi ghi lại theo số mới
        stmts.push(
          db.prepare("DELETE FROM cash_books WHERE reference_code = ? AND type = 'IN' AND category = 'Bán hàng / Thu nợ KH'").bind(oldOrder.code)
        );
        if (paid_amount > 0) {
          stmts.push(
            db.prepare(`
              INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
              VALUES (?, 'IN', ?, 'Bán hàng / Thu nợ KH', ?, ?, ?, ?)
            `).bind(
              await nextCode(db, 'cash_books', 'PT', created_at),
              paid_amount,
              payment_method,
              oldOrder.code,
              `Tạm ứng đơn đặt hàng ${oldOrder.code} của khách ${customer_name}`,
              created_at
            )
          );
        }
        await db.batch(stmts);
        return json({ success: true, total }, 200, origin);
      }

            // GET /api/orders/:id hoặc /api/invoices/:id (lấy chi tiết kèm items)
      if (pathname.match(/^\/api\/(orders|invoices)\/\d+$/) && request.method === 'GET') {
        const parts = pathname.split('/');
        const type = parts[2]; // 'orders' hoặc 'invoices'
        const id = parts[3];
        const itemTable = type === 'orders' ? 'order_items' : 'invoice_items';
        const foreignKey = type === 'orders' ? 'order_id' : 'invoice_id';

        let mainObj = await db.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(id).first();
        if (!mainObj) throw new HttpError(404, 'Không tìm thấy dữ liệu');

        // Chứng từ thiếu địa chỉ / SĐT (đơn cũ chưa lưu) thì lấy từ hồ sơ khách hàng
        if (mainObj.customer_code && (!str(mainObj.address) || !str(mainObj.customer_phone))) {
          const cu = await db.prepare('SELECT phone, address FROM customers WHERE code = ?').bind(mainObj.customer_code).first();
          if (cu) {
            mainObj = {
              ...mainObj,
              address: str(mainObj.address) || cu.address || null,
              customer_phone: str(mainObj.customer_phone) || cu.phone || null,
            };
          }
        }

        // Đã thanh toán / còn nợ: trừ cả tiền thu nợ nhập trong Thu chi
        if (type === 'invoices') {
          const adj = await adjustInvoice(db, mainObj);
          mainObj = { ...mainObj, paid_amount: adj.paid_amount, debt: adj.debt };
        } else if (!isPendingStatus(mainObj.status) && mainObj.invoice_code) {
          // Đơn đã xuất thành phiếu bán: công nợ lấy theo phiếu bán
          const inv = await db.prepare('SELECT * FROM invoices WHERE code = ?').bind(mainObj.invoice_code).first();
          if (inv) {
            const adj = await adjustInvoice(db, inv);
            mainObj = { ...mainObj, debt: Math.max(0, Number(adj.debt) || 0) };
          }
        }

        const items = await db.prepare(`
          select i.*, p.name as product_name, p.sku
          from ${itemTable} i
          left join products p on i.product_id = p.id
          where i.${foreignKey} = ?
        `).bind(id).all();

        return json({ ...mainObj, items: items.results || [] }, 200, origin);
      }

            // DELETE /api/orders/:id hoặc /api/invoices/:id
      if (pathname.match(/^\/api\/(orders|invoices)\/\d+$/) && request.method === 'DELETE') {
        const parts = pathname.split('/');
        const type = parts[2];
        const id = parts[3];
        const itemTable = type === 'orders' ? 'order_items' : 'invoice_items';
        const foreignKey = type === 'orders' ? 'order_id' : 'invoice_id';

        const head = await db.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(id).first();
        if (!head) throw new HttpError(404, 'Không tìm thấy dữ liệu');

        const stmts = [];
        if (type === 'invoices') {
          // Hoàn lại tồn kho
          const items = (await db.prepare('SELECT product_id, quantity FROM invoice_items WHERE invoice_id = ?').bind(id).all()).results || [];
          for (const item of items) {
            stmts.push(db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(item.quantity, item.product_id));
          }
          // Xóa phiếu bảo hành của phiếu bán này
          await ensureWarrantySchema(db);
          stmts.push(db.prepare('DELETE FROM warranties WHERE invoice_code = ?').bind(head.code));
          // Xóa phiếu thu tự sinh của phiếu bán này trong Sổ quỹ (tránh phiếu thu mồ côi)
          stmts.push(db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(head.code));
          // Đơn đặt hàng đã xuất thành phiếu này quay lại trạng thái chờ (phiếu thu tạm ứng của đơn vẫn giữ)
          stmts.push(db.prepare("UPDATE orders SET status = 'Pending', invoice_code = NULL WHERE invoice_code = ?").bind(head.code));
        } else if (isPendingStatus(head.status)) {
          // Xóa đơn đặt hàng chưa xuất bán -> xóa luôn phiếu thu tạm ứng của đơn
          stmts.push(db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(head.code));
        }
        stmts.push(db.prepare(`DELETE FROM ${itemTable} WHERE ${foreignKey} = ?`).bind(id));
        stmts.push(db.prepare(`DELETE FROM ${type} WHERE id = ?`).bind(id));
        await db.batch(stmts);
        return json({ success: true }, 200, origin);
      }
      // PUT /api/invoices/:id — Cập nhật phiếu bán hàng (SỬA LỖI: thêm unit_price, kiểm tra tồn kho, trả về code)
      if (is(/^\/api\/invoices\/\d+$/, 'PUT')) {
        const id = idOf(pathname);

        // 1. Kiểm tra phiếu cũ có tồn tại không
        const oldInv = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
        if (!oldInv) throw new HttpError(404, 'Không tìm thấy phiếu bán hàng');

        const b = await request.json();
        const cus = await resolveCustomer(db, b);
        const customer_name = cus.name;
        const customer_phone = cus.phone;
        const address = cus.address;
        const created_at = b.created_at ? isoDate(b.created_at) : oldInv.created_at;
        const payment_method = str(b.payment_method) || 'Tiền mặt';

        // 2. Kiểm tra dòng hàng mới, tính lại tổng tiền và công nợ
        const lines = normalizeItems(b.items);
        const newIds = await loadProducts(db, lines, { checkStock: false });
        const total = sumTotal(lines);
        const paid_amount = Math.min(money(b.paid_amount), total);
        const debt = total - paid_amount;

        // 3. Dòng hàng cũ: sẽ hoàn lại tồn kho
        const oldItems = (await db.prepare('SELECT product_id, quantity FROM invoice_items WHERE invoice_id = ?').bind(id).all()).results || [];
        const ids = [...new Set([...oldItems.map((i) => i.product_id), ...newIds])];

        const stmts = [
          ...(cus.create ? [cus.create] : []),
          // Hoàn lại tồn kho theo phiếu cũ
          ...oldItems.map((i) =>
            db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(i.quantity, i.product_id)),
          // Cập nhật thông tin phiếu
            db.prepare('UPDATE invoices SET customer_name = ?, customer_phone = ?, address = ?, total = ?, paid_amount = ?, debt = ?, payment_method = ?, created_at = ?, customer_code = ? WHERE id = ?')
            .bind(customer_name, customer_phone, address, total, paid_amount, debt, payment_method, created_at, cus.code, id),
          // Làm mới chi tiết sản phẩm
          db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id),
          // Bảng invoice_items có cột unit_price (NOT NULL) nên ghi cả unit_price lẫn price
          ...lines.map((l) =>
            db.prepare('INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, price, discount, total, chassis_color) VALUES (?,?,?,?,?,?,?,?)')
              .bind(id, l.product_id, l.quantity, l.price, l.price, l.discount, l.total, l.chassis_color)),
          // Trừ tồn kho theo phiếu mới
          ...lines.map((l) =>
            db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)),
          // Đồng bộ Sổ quỹ: xóa phiếu thu cũ của hóa đơn này
          db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(oldInv.code),
        ];

                // Tạo lại phiếu thu (trừ phần tạm ứng đã có phiếu thu riêng của đơn đặt hàng liên kết)
        const linkedOrders = (await db.prepare(
          `SELECT code FROM orders
           WHERE invoice_code = ?1
              OR (COALESCE(invoice_code, '') = '' AND status LIKE '%Hoàn thành%'
                  AND ?2 <> '' AND customer_code = ?2 AND ABS(total - ?3) <= 10)`
        ).bind(oldInv.code, oldInv.customer_code || '', Number(oldInv.total) || 0).all()).results || [];
        
        let depositRecorded = 0;
        if (linkedOrders.length) {
          const orderCodes = linkedOrders.map((o) => o.code);
          const dep = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM cash_books WHERE type = 'IN' AND reference_code IN (${placeholders(orderCodes)})`)
            .bind(...orderCodes).first();
          depositRecorded = Number(dep?.s) || 0;
        }
        const cashAmount = Math.max(0, paid_amount - depositRecorded);
        if (cashAmount > 0) {
          const noteText = `Thu tiền bán hàng từ khách ${customer_name} theo hóa đơn ${oldInv.code} (Đã cập nhật)`;
          stmts.push(
            db.prepare(`
              INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
              VALUES (?, 'IN', ?, 'Bán hàng / Thu nợ KH', ?, ?, ?, ?)
              `).bind(await nextCode(db, 'cash_books', 'PT', created_at), cashAmount, payment_method, oldInv.code, noteText, created_at)
          );
        }

        // Chốt chặn: nếu tồn kho bị âm thì hủy toàn bộ (rollback)
        stmts.push(stockGuard(db, ids));

        await runBatch(db, stmts, 'Không đủ tồn kho để sửa phiếu. Vui lòng tải lại và kiểm tra số lượng');
        return json({ success: true, code: oldInv.code, total }, 200, origin);
      }


      // ===== 1. LẤY DANH SÁCH PHIẾU TRẢ HÀNG & THỐNG KÊ =====
      if (pathname === '/api/return-orders' && method === 'GET') {
        await ensureReturnSchema(db);
        const returnsRes = await db.prepare('SELECT * FROM return_orders ORDER BY created_at DESC').all();
        const returns = returnsRes.results || [];

        let totalReturns = returns.length;
        let pendingReturns = returns.filter(r => r.status === 'Đang xử lý').length;
        // SỬA: trạng thái lưu dạng "Hoàn Thành (Cộng kho & trừ nợ)" nên phải so khớp theo cụm "hoàn thành"
        let completedReturns = returns.filter(r => isCompletedReturn(r.status)).length;
        let totalRefundAmount = returns.reduce((sum, r) => sum + (Number(r.refund_amount) || 0), 0);

        return json({
          success: true,
          data: {
            list: returns,
            stats: {
              total: totalReturns,
              pending: pendingReturns,
              completed: completedReturns,
              totalRefund: totalRefundAmount
            }
          }
        }, 200, origin);
      }

      // ===== 2. TẠO PHIẾU TRẢ HÀNG MỚI =====
      if (pathname === '/api/return-orders' && method === 'POST') {
        await ensureReturnSchema(db);
        const body = await request.json();
        const { invoice_code, customer_name, return_date, reason, refund_amount } = body;
        const statusText = str(body.status) || 'Hoàn Thành';
        const code = str(body.code) || await nextCode(db, 'return_orders', 'PTB', return_date);

        // Chuẩn hoá danh sách hàng trả (phải có sản phẩm để cộng kho và lên báo cáo)
        const lines = normalizeReturnLines(body.items);
        if (lines.length === 0) throw new HttpError(400, 'Danh sách sản phẩm trả lại trống');
        await loadProducts(db, lines, { checkStock: false });

        const totalValue = lines.reduce((s, l) => s + l.quantity * l.price, 0); // tổng giá trị hàng trả
        const refundTotal = Math.min(money(refund_amount), totalValue);          // tiền mặt hoàn lại (không vượt tổng)
        const retDate = return_date || new Date().toISOString().slice(0, 10);
        const custCode = await lookupCustomerCode(db, body.customer_code, customer_name);

        const stmts = [
          // Lưu phiếu trả hàng
          db.prepare(`
            INSERT INTO return_orders (code, invoice_code, customer_name, return_date, reason, refund_amount, total_amount, status, created_at, customer_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
          `).bind(
            code,
            invoice_code || '',
            customer_name || 'Khách lẻ',
            retDate,
            reason || 'Sản phẩm lỗi',
            refundTotal,
            totalValue,
            statusText,
            custCode
          ),
          // Lưu chi tiết từng sản phẩm trả lại
          ...lines.map((l) =>
            db.prepare('INSERT INTO return_order_items (return_order_id, product_id, quantity, price, total) VALUES ((SELECT id FROM return_orders WHERE code = ?),?,?,?,?)')
              .bind(code, l.product_id, l.quantity, l.price, l.quantity * l.price)),
        ];

        // Nếu trạng thái là Hoàn Thành, cộng lại số lượng vào kho sản phẩm (cùng 1 transaction)
        if (isCompletedReturn(statusText)) {
          stmts.push(...lines.map((l) =>
            db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)));

          // [FIX] Trả tiền hoàn cho khách -> tự sinh PHIẾU CHI vào Sổ quỹ (thu chi)
          // Số tiền thực chi: ưu tiên field refund_paid (nếu giao diện gửi), mặc định = refund_amount. Không vượt quá tiền hoàn.
          const cashRefund = Math.min(
            body.refund_paid !== undefined ? money(body.refund_paid) : refundTotal,
            refundTotal
          );
          if (cashRefund > 0) {
            const custName = customer_name || 'Khách lẻ';
            stmts.push(
              db.prepare(`
                INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
                VALUES (?, 'OUT', ?, 'Chi hoàn trả khách hàng', ?, ?, ?, ?)
                `).bind(
                await nextCode(db, 'cash_books', 'TC', retDate),
                cashRefund,
                str(body.payment_method) || 'Tiền mặt',
                code,
                `Hoàn tiền trả hàng cho khách ${custName} theo phiếu trả ${code}${invoice_code ? ' (HĐ ' + invoice_code + ')' : ''}`,
                retDate // ngày phiếu chi = ngày trả hàng
              )
            );
          }
        }

        await db.batch(stmts);

        return json({ success: true, message: 'Tạo phiếu trả hàng thành công' }, 200, origin);
      }

      // ===== [MỚI] XEM CHI TIẾT PHIẾU TRẢ HÀNG BÁN =====
      if (is(/^\/api\/return-orders\/\d+$/, 'GET')) {
        await ensureReturnSchema(db);
        const id = idOf(pathname);
        const head = await db.prepare('SELECT * FROM return_orders WHERE id = ?').bind(id).first();
        if (!head) throw new HttpError(404, 'Không tìm thấy phiếu trả hàng');
        const items = await db.prepare(`
          SELECT roi.*, p.name AS product_name, p.sku, p.unit
          FROM return_order_items roi LEFT JOIN products p ON roi.product_id = p.id
          WHERE roi.return_order_id = ?
        `).bind(id).all();
        return json({ ...head, items: items.results || [] }, 200, origin);
      }

      // ===== [MỚI] SỬA PHIẾU TRẢ HÀNG BÁN (cập nhật tại chỗ, KHÔNG tạo phiếu mới, giữ nguyên mã phiếu) =====
      if (is(/^\/api\/return-orders\/\d+$/, 'PUT')) {
        await ensureReturnSchema(db);
        const id = idOf(pathname);
        const old = await db.prepare('SELECT * FROM return_orders WHERE id = ?').bind(id).first();
        if (!old) throw new HttpError(404, 'Không tìm thấy phiếu trả hàng');

        const body = await request.json();
        const lines = normalizeReturnLines(body.items);
        if (lines.length === 0) throw new HttpError(400, 'Danh sách sản phẩm trả lại trống');
        const newIds = await loadProducts(db, lines, { checkStock: false });

        const oldItems = (await db.prepare('SELECT product_id, quantity FROM return_order_items WHERE return_order_id = ?').bind(id).all()).results || [];
        const ids = [...new Set([...oldItems.map((i) => i.product_id), ...newIds])];

        const statusText = str(body.status) || old.status || 'Hoàn Thành';
        const totalValue = lines.reduce((s, l) => s + l.quantity * l.price, 0);
        const refundTotal = Math.min(money(body.refund_amount), totalValue);
        const retDate = str(body.return_date) || old.return_date || new Date().toISOString().slice(0, 10);
        const custName = str(body.customer_name) || old.customer_name || 'Khách lẻ';
        const invoiceCode = body.invoice_code !== undefined ? str(body.invoice_code) : (old.invoice_code || '');
        const reason = str(body.reason) || old.reason || 'Sản phẩm lỗi';
        const custCode = (await lookupCustomerCode(db, body.customer_code, custName)) || old.customer_code || '';

        // Ngày phiếu chi trong Sổ quỹ = ngày trả hàng
        const cashDate = retDate;

        const stmts = [];
        // 1. Hoàn tác ảnh hưởng của phiếu cũ: phiếu cũ đã cộng kho thì trừ lại
        if (isCompletedReturn(old.status)) {
          stmts.push(...oldItems.map((i) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(i.quantity, i.product_id)));
        }
        // 2. Xóa phiếu chi cũ trong Sổ quỹ và chi tiết cũ
        stmts.push(db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(old.code));
        stmts.push(db.prepare('DELETE FROM return_order_items WHERE return_order_id = ?').bind(id));
        // 3. Cập nhật chính phiếu này
        stmts.push(
        db.prepare('UPDATE return_orders SET invoice_code = ?, customer_name = ?, return_date = ?, reason = ?, refund_amount = ?, total_amount = ?, status = ?, customer_code = ? WHERE id = ?')
            .bind(invoiceCode, custName, retDate, reason, refundTotal, totalValue, statusText, custCode, id)
        );
        // 4. Ghi lại chi tiết mới
        stmts.push(...lines.map((l) =>
          db.prepare('INSERT INTO return_order_items (return_order_id, product_id, quantity, price, total) VALUES (?,?,?,?,?)')
            .bind(id, l.product_id, l.quantity, l.price, l.quantity * l.price)));
        // 5. Áp dụng phiếu mới: hoàn thành thì cộng kho + sinh lại phiếu chi
        if (isCompletedReturn(statusText)) {
          stmts.push(...lines.map((l) => db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)));
          const cashRefund = Math.min(body.refund_paid !== undefined ? money(body.refund_paid) : refundTotal, refundTotal);
          if (cashRefund > 0) {
            stmts.push(
              db.prepare(`
                INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
                VALUES (?, 'OUT', ?, 'Chi hoàn trả khách hàng', ?, ?, ?, ?)
              `).bind(
                await nextCode(db, 'cash_books', 'TC', cashDate), cashRefund, str(body.payment_method) || 'Tiền mặt', old.code,
                `Hoàn tiền trả hàng cho khách ${custName} theo phiếu trả ${old.code}${invoiceCode ? ' (HĐ ' + invoiceCode + ')' : ''} (Đã cập nhật)`,
                cashDate
              )
            );
          }
        }
        stmts.push(stockGuard(db, ids)); // kho âm thì rollback toàn bộ
        await runBatch(db, stmts, 'Không thể sửa phiếu: tồn kho không đủ để hoàn lại (hàng đã trả có thể đã được bán đi)');
        return json({ success: true, code: old.code }, 200, origin);
      }

      // ===== [MỚI] XÓA PHIẾU TRẢ HÀNG BÁN =====
      if (is(/^\/api\/return-orders\/\d+$/, 'DELETE')) {
        await ensureReturnSchema(db);
        const id = idOf(pathname);
        const head = await db.prepare('SELECT * FROM return_orders WHERE id = ?').bind(id).first();
        if (!head) throw new HttpError(404, 'Không tìm thấy phiếu trả hàng');
        const items = (await db.prepare('SELECT product_id, quantity FROM return_order_items WHERE return_order_id = ?').bind(id).all()).results || [];
        const ids = [...new Set(items.map((i) => i.product_id))];

        const stmts = [];
        if (isCompletedReturn(head.status)) {
          // Phiếu đã cộng kho -> trừ lại khi xóa
          stmts.push(...items.map((i) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(i.quantity, i.product_id)));
        }
        stmts.push(db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(head.code));
        stmts.push(db.prepare('DELETE FROM return_order_items WHERE return_order_id = ?').bind(id));
        stmts.push(db.prepare('DELETE FROM return_orders WHERE id = ?').bind(id));
        if (isCompletedReturn(head.status) && ids.length) stmts.push(stockGuard(db, ids));
        await runBatch(db, stmts, 'Không thể xóa phiếu: hàng trả lại đã được bán nên tồn kho không đủ để hoàn lại');
        return json({ success: true }, 200, origin);
      }

      // ===== 7. QUẢN LÝ THU CHI =====
      if (pathname === '/api/cash-book' && method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM cash_books ORDER BY id DESC').all();

        let totalIn = 0;
        let totalOut = 0;
        (results || []).forEach(item => {
          if (item.type === 'IN') totalIn += Number(item.amount) || 0;
          if (item.type === 'OUT') totalOut += Number(item.amount) || 0;
        });
        const netProfit = totalIn - totalOut;

        return json({
          success: true,
          summary: { totalIn, totalOut, netProfit, balance: netProfit },
          items: results || []
        }, 200, origin);
      }

      if (pathname === '/api/cash-book' && method === 'POST') {
        const b = await request.json();
        const type = b.type; // 'IN' hoặc 'OUT'
        const amount = Number(b.amount) || 0;
        const category = str(b.category) || 'Khác';
        if (amount <= 0) throw new HttpError(400, 'Số tiền giao dịch phải lớn hơn 0');

        const code = await nextCode(db, 'cash_books', type === 'IN' ? 'PT' : 'TC', b.created_at);
        await db.prepare(`
          INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          code,
          type,
          amount,
          category,
          str(b.payment_method) || 'Chuyển khoản',
          str(b.reference_code) || '',
          str(b.note) || '',
          b.created_at || new Date().toISOString()
        ).run();

        return json({ success: true, code }, 201, origin);
      }

      if (is(/^\/api\/cash-book\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        await db.prepare('DELETE FROM cash_books WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/cash-book\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const existing = await db.prepare('SELECT id FROM cash_books WHERE id = ?').bind(id).first();
        if (!existing) throw new HttpError(404, 'Không tìm thấy phiếu thu chi');

        const b = await request.json();
        const type = b.type; // 'IN' hoặc 'OUT'
        const amount = Number(b.amount) || 0;
        const category = str(b.category) || 'Khác';
        if (amount <= 0) throw new HttpError(400, 'Số tiền giao dịch phải lớn hơn 0');

        await db.prepare(`
          UPDATE cash_books
          SET type = ?, amount = ?, category = ?, payment_method = ?, reference_code = ?, note = ?,
              created_at = COALESCE(?, created_at)
          WHERE id = ?
        `).bind(
          type,
          amount,
          category,
          str(b.payment_method) || 'Chuyển khoản',
          str(b.reference_code) || '',
          str(b.note) || '',
          str(b.created_at || b.date) || null, // không gửi ngày thì giữ nguyên ngày cũ
          id
        ).run();

        return json({ success: true }, 200, origin);
      }

      // ===== TRẢ HÀNG NHẬP =====
      if (pathname === '/api/purchase-returns' && method === 'GET') {
        await ensurePurchaseReturnSchema(db);
        const { results } = await db.prepare('SELECT * FROM purchase_return_orders ORDER BY id DESC').all();
        const list = results || [];
        return json({
          success: true,
          data: {
            list,
            stats: {
              total: list.length,
              totalAmount: list.reduce((s, r) => s + (Number(r.total_amount) || 0), 0),
              totalReceived: list.reduce((s, r) => s + (Number(r.received_amount) || 0), 0),
              completed: list.filter((r) => isCompletedReturn(r.status)).length,
            },
          },
        }, 200, origin);
      }

      if (pathname === '/api/purchase-returns' && method === 'POST') {
        await ensurePurchaseReturnSchema(db);
        const b = await request.json();

        const supplier_id = Number(b.supplier_id);
        const sup = supplier_id ? await db.prepare('SELECT id, name FROM suppliers WHERE id = ?').bind(supplier_id).first() : null;
        if (!sup) throw new HttpError(400, 'Vui lòng chọn nhà cung cấp');

        const lines = normalizeReturnLines(b.items);
        if (lines.length === 0) throw new HttpError(400, 'Danh sách sản phẩm trả lại trống');

        const statusText = str(b.status) || 'Hoàn Thành';
        const done = isCompletedReturn(statusText);
        const ids = await loadProducts(db, lines, { checkStock: done }); // trả NCC thì phải đủ tồn kho

        const total = lines.reduce((s, l) => s + l.quantity * l.price, 0);
        const retDate = str(b.return_date) || new Date().toISOString().slice(0, 10);
        const code = await nextCode(db, 'purchase_return_orders', 'RTN', retDate);
        const payMethod = str(b.payment_method) || 'Tiền mặt';

        // [FIX] Số tiền đã thu lại từ NCC (không vượt quá tổng giá trị hàng trả). Chỉ ghi nhận khi phiếu đã hoàn thành.
        // Giao diện gửi lên: received_amount (hoặc refund_received / paid_amount)
        const receivedRaw = b.received_amount ?? b.refund_received ?? b.paid_amount ?? 0;
        const received = done ? Math.min(money(receivedRaw), total) : 0;

        const stmts = [
          db.prepare(`INSERT INTO purchase_return_orders (code, purchase_code, supplier_id, supplier_name, return_date, reason, total_amount, received_amount, payment_method, status, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(code, str(b.purchase_code), sup.id, sup.name, retDate,
                  str(b.reason) || 'Hàng thừa / Trả lại', total, received, payMethod, statusText, new Date().toISOString()),
          ...lines.map((l) =>
            db.prepare('INSERT INTO purchase_return_order_items (return_id, product_id, quantity, price, total) VALUES ((SELECT id FROM purchase_return_orders WHERE code = ?),?,?,?,?)')
              .bind(code, l.product_id, l.quantity, l.price, l.quantity * l.price)),
        ];
        if (done) {
          stmts.push(...lines.map((l) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)));
          stmts.push(stockGuard(db, ids));

          // [FIX] Thu lại tiền hoàn từ NCC -> tự sinh PHIẾU THU vào Sổ quỹ (thu chi)
          if (received > 0) {
            stmts.push(
              db.prepare(`
                INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
                VALUES (?, 'IN', ?, 'Thu hoàn tiền NCC', ?, ?, ?, ?)
                `).bind(
                await nextCode(db, 'cash_books', 'PT', retDate),
                received,
                payMethod,
                code,
                `Thu hoàn tiền trả hàng nhập từ ${sup.name} theo phiếu ${code}`,
                retDate // ngày phiếu thu = ngày trả hàng
              )
            );
          }
        }
        await runBatch(db, stmts, 'Tồn kho vừa thay đổi, không đủ hàng để trả NCC. Vui lòng tải lại và thử lại');
        return json({ success: true, code, total, received }, 201, origin);
      }

      if (is(/^\/api\/purchase-returns\/\d+$/, 'GET')) {
        await ensurePurchaseReturnSchema(db);
        const id = idOf(pathname);
        const head = await db.prepare('SELECT * FROM purchase_return_orders WHERE id = ?').bind(id).first();
        if (!head) throw new HttpError(404, 'Không tìm thấy phiếu trả hàng nhập');
        const items = await db.prepare(`
          SELECT i.*, p.name AS product_name, p.sku
          FROM purchase_return_order_items i LEFT JOIN products p ON i.product_id = p.id
          WHERE i.return_id = ?
        `).bind(id).all();
        return json({ ...head, items: items.results || [] }, 200, origin);
      }

      // ===== [MỚI] SỬA PHIẾU TRẢ HÀNG NHẬP (cập nhật tại chỗ, KHÔNG tạo phiếu mới, giữ nguyên mã phiếu) =====
      if (is(/^\/api\/purchase-returns\/\d+$/, 'PUT')) {
        await ensurePurchaseReturnSchema(db);
        const id = idOf(pathname);
        const old = await db.prepare('SELECT * FROM purchase_return_orders WHERE id = ?').bind(id).first();
        if (!old) throw new HttpError(404, 'Không tìm thấy phiếu trả hàng nhập');

        const b = await request.json();
        const supplier_id = Number(b.supplier_id) || old.supplier_id;
        const sup = await db.prepare('SELECT id, name FROM suppliers WHERE id = ?').bind(supplier_id).first();
        if (!sup) throw new HttpError(400, 'Vui lòng chọn nhà cung cấp');

        const lines = normalizeReturnLines(b.items);
        if (lines.length === 0) throw new HttpError(400, 'Danh sách sản phẩm trả lại trống');
        const newIds = await loadProducts(db, lines, { checkStock: false });

        const oldItems = (await db.prepare('SELECT product_id, quantity FROM purchase_return_order_items WHERE return_id = ?').bind(id).all()).results || [];
        const ids = [...new Set([...oldItems.map((i) => i.product_id), ...newIds])];

        const statusText = str(b.status) || old.status || 'Hoàn Thành';
        const done = isCompletedReturn(statusText);
        const total = lines.reduce((s, l) => s + l.quantity * l.price, 0);
        const retDate = str(b.return_date) || old.return_date || new Date().toISOString().slice(0, 10);
        const payMethod = str(b.payment_method) || old.payment_method || 'Tiền mặt';
        const reason = str(b.reason) || old.reason || 'Hàng thừa / Trả lại';
        const purchaseCode = b.purchase_code !== undefined ? str(b.purchase_code) : (old.purchase_code || '');
        const receivedRaw = b.received_amount ?? b.refund_received ?? b.paid_amount ?? 0;
        const received = done ? Math.min(money(receivedRaw), total) : 0;

        // Ngày phiếu thu trong Sổ quỹ = ngày trả hàng
        const cashDate = retDate;

        const stmts = [];
        // 1. Hoàn tác phiếu cũ: đã trừ kho thì cộng lại
        if (isCompletedReturn(old.status)) {
          stmts.push(...oldItems.map((i) => db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(i.quantity, i.product_id)));
        }
        // 2. Xóa phiếu thu cũ trong Sổ quỹ + chi tiết cũ
        stmts.push(db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(old.code));
        stmts.push(db.prepare('DELETE FROM purchase_return_order_items WHERE return_id = ?').bind(id));
        // 3. Cập nhật chính phiếu này
        stmts.push(
          db.prepare(`UPDATE purchase_return_orders
                      SET purchase_code = ?, supplier_id = ?, supplier_name = ?, return_date = ?, reason = ?,
                          total_amount = ?, received_amount = ?, payment_method = ?, status = ?
                      WHERE id = ?`)
            .bind(purchaseCode, sup.id, sup.name, retDate, reason, total, received, payMethod, statusText, id)
        );
        // 4. Ghi chi tiết mới
        stmts.push(...lines.map((l) =>
          db.prepare('INSERT INTO purchase_return_order_items (return_id, product_id, quantity, price, total) VALUES (?,?,?,?,?)')
            .bind(id, l.product_id, l.quantity, l.price, l.quantity * l.price)));
        // 5. Áp dụng phiếu mới
        if (done) {
          stmts.push(...lines.map((l) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)));
          if (received > 0) {
            stmts.push(
              db.prepare(`
                INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
                VALUES (?, 'IN', ?, 'Thu hoàn tiền NCC', ?, ?, ?, ?)
                `).bind(await nextCode(db, 'cash_books', 'PT', cashDate), received, payMethod, old.code,
                      `Thu hoàn tiền trả hàng nhập từ ${sup.name} theo phiếu ${old.code} (Đã cập nhật)`, cashDate)
            );
          }
        }
        stmts.push(stockGuard(db, ids));
        await runBatch(db, stmts, 'Tồn kho không đủ để trả NCC theo số lượng mới. Vui lòng kiểm tra lại số lượng');
        return json({ success: true, code: old.code, total, received }, 200, origin);
      }

      if (is(/^\/api\/purchase-returns\/\d+$/, 'DELETE')) {
        await ensurePurchaseReturnSchema(db);
        const id = idOf(pathname);
        const head = await db.prepare('SELECT * FROM purchase_return_orders WHERE id = ?').bind(id).first();
        if (!head) throw new HttpError(404, 'Không tìm thấy phiếu trả hàng nhập');
        const items = (await db.prepare('SELECT product_id, quantity FROM purchase_return_order_items WHERE return_id = ?').bind(id).all()).results || [];
        const stmts = [];
        if (isCompletedReturn(head.status)) {
          // Xóa phiếu trả -> hoàn lại số hàng đã trừ khỏi kho
          stmts.push(...items.map((i) => db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(i.quantity, i.product_id)));
        }
        // [FIX] Xóa luôn phiếu thu hoàn tiền NCC trong Sổ quỹ để thu chi không bị lệch
        stmts.push(db.prepare('DELETE FROM cash_books WHERE reference_code = ?').bind(head.code));
        stmts.push(db.prepare('DELETE FROM purchase_return_order_items WHERE return_id = ?').bind(id));
        stmts.push(db.prepare('DELETE FROM purchase_return_orders WHERE id = ?').bind(id));
        await db.batch(stmts);
        return json({ success: true }, 200, origin);
      }

      // ===== 3. NHÀ CUNG CẤP =====
      if (pathname === '/api/suppliers' && method === 'GET') {
        await ensurePurchaseReturnSchema(db);
        // Công nợ = tổng nhập - (tiền trả ngay trên phiếu nhập + các khoản thanh toán về sau) - hàng đã trả NCC + tiền NCC đã hoàn lại cho mình
        // [FIX] Cộng lại received_amount: nếu NCC đã hoàn tiền mặt thì phần đó không còn làm giảm nợ nữa
        const { results } = await db.prepare(`
  SELECT s.*,
    COALESCE(p.total_purchase, 0) AS total_purchase,
    COALESCE(p.po_paid, 0) + COALESCE(pay.total_paid, 0) + COALESCE(cb.cash_out, 0) - COALESCE(cb.cash_in, 0) AS total_paid,
    COALESCE(p.total_purchase, 0) - COALESCE(p.po_paid, 0) - COALESCE(pay.total_paid, 0)
      - COALESCE(cb.cash_out, 0) + COALESCE(cb.cash_in, 0)
      - COALESCE(rt.total_returned, 0) + COALESCE(rt.total_received, 0) AS total_debt
  FROM suppliers s
  LEFT JOIN (SELECT supplier_id, SUM(total) AS total_purchase, SUM(paid_amount) AS po_paid
             FROM purchase_orders GROUP BY supplier_id) p ON s.id = p.supplier_id
  LEFT JOIN (SELECT supplier_id, SUM(amount) AS total_paid
             FROM supplier_payments GROUP BY supplier_id) pay ON s.id = pay.supplier_id
  LEFT JOIN (SELECT supplier_id, SUM(total_amount) AS total_returned, SUM(COALESCE(received_amount, 0)) AS total_received
             FROM purchase_return_orders WHERE status LIKE '%Hoàn Thành%' GROUP BY supplier_id) rt ON s.id = rt.supplier_id
  LEFT JOIN (SELECT reference_code,
                    SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END) AS cash_out,
                    SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END) AS cash_in
             FROM cash_books
             WHERE category LIKE '%NCC%'
             GROUP BY reference_code) cb ON cb.reference_code = s.code
  ORDER BY s.id DESC
`).all();
        return json(results || [], 200, origin);
      }

      if (pathname === '/api/suppliers' && method === 'POST') {
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        const code = str(b.code) || genCode('NCC');
        let r;
        try {
          r = await db.prepare('INSERT INTO suppliers (code, name, phone, address, status) VALUES (?,?,?,?,?)')
            .bind(code, name, str(b.phone) || null, str(b.address) || null, b.status === 'inactive' ? 'inactive' : 'active').run();
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã NCC');
          throw err;
        }
        // Trả thêm id để giao diện tự chọn nhà cung cấp vừa tạo (nút "Thêm nhanh NCC")
        return json({ success: true, code, id: r.meta?.last_row_id }, 201, origin);
      }

      if (pathname === '/api/suppliers/import' && method === 'POST') {
        const { items = [] } = await request.json();
        let invalid = 0;
        const stmts = [];
        for (const it of items) {
          const name = str(it.name);
          if (!name) { invalid++; continue; }
          stmts.push(
            db.prepare(`INSERT INTO suppliers (code, name, phone, address, status) VALUES (?,?,?,?,?)
                        ON CONFLICT(code) DO UPDATE SET name = excluded.name, phone = excluded.phone, address = excluded.address, status = excluded.status`)
              .bind(str(it.code) || genCode('NCC'), name, str(it.phone) || null, str(it.address) || null, it.status === 'inactive' ? 'inactive' : 'active'));
        }
        const r = await runImport(db, stmts);
        return json({ success: true, successCount: r.successCount, errorCount: r.errorCount + invalid }, 200, origin);
      }

      if (is(/^\/api\/suppliers\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        try {
          // Để trống mã -> giữ nguyên mã cũ (trước đây bị ghi đè thành 'NCC-DEFAULT')
          const r = await db.prepare("UPDATE suppliers SET code = COALESCE(NULLIF(?, ''), code), name = ?, phone = ?, address = ?, status = ? WHERE id = ?")
            .bind(str(b.code), name, str(b.phone) || null, str(b.address) || null, b.status === 'inactive' ? 'inactive' : 'active', id).run();
          if (!r.meta?.changes) throw new HttpError(404, 'Không tìm thấy nhà cung cấp');
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã NCC');
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/suppliers\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const used = await db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE supplier_id = ?').bind(id).first();
        if (used?.n > 0) throw new HttpError(409, 'Nhà cung cấp đã có phiếu nhập nên không thể xóa (hãy chuyển sang "Ngừng")');
        await db.prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/suppliers\/\d+\/history$/, 'GET')) {
        const id = idOf(pathname);
        const safeAll = async (table) => {
          try { return (await db.prepare(`SELECT * FROM ${table} WHERE supplier_id = ? ORDER BY id DESC`).bind(id).all()).results || []; }
          catch (e) { return []; }
        };
        return json({
          purchases: await safeAll('purchase_orders'),
          payments: await safeAll('supplier_payments'),
          returns: await (async () => {
            try {
              await ensurePurchaseReturnSchema(db);
              return (await db.prepare('SELECT *, total_amount AS total, reason AS note, return_date AS created_at FROM purchase_return_orders WHERE supplier_id = ? ORDER BY id DESC').bind(id).all()).results || [];
            } catch (e) { return []; }
          })(),
        }, 200, origin);
      }

      // ===== 4. PHIẾU NHẬP HÀNG =====
      if (pathname === '/api/purchase_orders' && method === 'GET') {
        const { results } = await db.prepare(`
          SELECT po.*, s.name AS supplier_name
          FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
          ORDER BY po.id DESC
        `).all();
        return json(results || [], 200, origin);
      }

      if (pathname === '/api/purchase_orders' && method === 'POST') {
        const reqData = await request.json();
        const po = await buildPurchase(db, reqData);
        await checkUnitsUnique(db, po.units, null);
        const code = await nextCode(db, 'purchase_orders', 'PN', reqData.created_at);

        // Lấy chính xác ngày do người dùng chọn từ frontend gửi lên (nếu có), nếu không mới lấy ngày hiện tại
        const customDate = reqData.created_at || new Date().toISOString();

        const stmts = [
          db.prepare('INSERT INTO purchase_orders (code, supplier_id, total, paid_amount, debt, payment_method, created_at) VALUES (?,?,?,?,?,?,?)')
            .bind(code, po.supplier_id, po.total, po.paid_amount, po.debt, po.payment_method, customDate),
          ...po.lines.map((l) =>
            db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, price, discount, total) VALUES ((SELECT id FROM purchase_orders WHERE code = ?),?,?,?,?,?)')
              .bind(code, l.product_id, l.quantity, l.price, l.discount, l.total)),
          ...po.lines.map((l) =>
            db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)),
          // Ghi số khung / số sườn của từng xe kèm mã phiếu nhập
          ...unitStatements(db, po.units, code, customDate),
        ];

        // Tự động sinh phiếu chi nếu có thanh toán tiền ngay trên phiếu nhập
        // (gộp chung vào 1 lần db.batch: phiếu nhập và phiếu chi cùng thành công hoặc cùng bị hủy)
        if (Number(po.paid_amount) > 0) {
          const sup = await db.prepare('SELECT name FROM suppliers WHERE id = ?').bind(po.supplier_id).first();
          const supName = sup ? sup.name : 'Nhà cung cấp';
          const noteText = `Thanh toán tiền mua hàng cho ${supName} theo phiếu ${code}`;

          stmts.push(
            db.prepare(`
              INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
              VALUES (?, 'OUT', ?, 'Mua hàng / Trả nợ NCC', ?, ?, ?, ?)
              `).bind(await nextCode(db, 'cash_books', 'TC', customDate), po.paid_amount, po.payment_method || 'Chuyển khoản', code, noteText, customDate)
          );
        }

        await db.batch(stmts);
        return json({ success: true, code, total: po.total }, 201, origin);
      }

      if (is(/^\/api\/purchase_orders\/\d+$/, 'GET')) {
        const id = idOf(pathname);
        const po = await db.prepare(`
          SELECT po.*, s.name AS supplier_name
          FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
          WHERE po.id = ?
        `).bind(id).first();
        if (!po) throw new HttpError(404, 'Không tìm thấy phiếu nhập');
        const itemsRes = await db.prepare(`
          SELECT poi.*, p.name AS product_name, p.sku, p.unit
          FROM purchase_order_items poi LEFT JOIN products p ON poi.product_id = p.id
          WHERE poi.purchase_order_id = ?
        `).bind(id).all();
                const unitRows = (await db.prepare('SELECT product_id, chassis, frame FROM chassis_units WHERE purchase_order_id = ? ORDER BY id').bind(id).all()).results || [];
        const byProduct = new Map();
        for (const u of unitRows) {
          const key = String(u.product_id);
          if (!byProduct.has(key)) byProduct.set(key, []);
          byProduct.get(key).push({ chassis: u.chassis || '', frame: u.frame || '' });
        }
        const itemsWithSerials = (itemsRes.results || []).map((it) => {
          const key = String(it.product_id);
          const serials = byProduct.get(key) || [];
          byProduct.delete(key); // nếu một sản phẩm xuất hiện ở 2 dòng thì chỉ gắn cho dòng đầu
          return { ...it, serials };
        });
        return json({ ...po, items: itemsWithSerials }, 200, origin);
      }

      // PUT: trước đây Worker KHÔNG có route này nên nút "Sửa phiếu nhập" không lưu được gì
            if (is(/^\/api\/purchase_orders\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        // Lấy thêm mã phiếu (code) để tìm đúng phiếu chi trong Sổ quỹ
        const existing = await db.prepare('SELECT id, code FROM purchase_orders WHERE id = ?').bind(id).first();
        if (!existing) throw new HttpError(404, 'Không tìm thấy phiếu nhập');

        const reqData = await request.json();
        const po = await buildPurchase(db, reqData);
        await checkUnitsUnique(db, po.units, id);
        const customDate = reqData.created_at || new Date().toISOString();

        const oldItems = (await db.prepare('SELECT product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?').bind(id).all()).results || [];
        const ids = [...new Set([...oldItems.map((i) => i.product_id), ...po.ids])];

        const stmts = [
          ...oldItems.map((i) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(i.quantity, i.product_id)),
          db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').bind(id),
          db.prepare('UPDATE purchase_orders SET supplier_id = ?, total = ?, paid_amount = ?, debt = ?, payment_method = ?, created_at = ? WHERE id = ?')
            .bind(po.supplier_id, po.total, po.paid_amount, po.debt, po.payment_method, customDate, id),
          ...po.lines.map((l) =>
            db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, price, discount, total) VALUES (?,?,?,?,?,?)')
              .bind(id, l.product_id, l.quantity, l.price, l.discount, l.total)),
          ...po.lines.map((l) => db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)),

          // Ghi lại số khung / số sườn theo nội dung phiếu mới
          db.prepare('DELETE FROM chassis_units WHERE purchase_order_id = ?').bind(id),
          ...unitStatements(db, po.units, existing.code, customDate),

          // Đồng bộ Sổ quỹ: xóa phiếu chi cũ của phiếu nhập này (chỉ phiếu chi thanh toán tiền hàng)
          db.prepare("DELETE FROM cash_books WHERE reference_code = ? AND type = 'OUT' AND category = 'Mua hàng / Trả nợ NCC'")
            .bind(existing.code),
        ];

        // Tạo lại phiếu chi theo ngày và số tiền mới (nếu có thanh toán)
        if (Number(po.paid_amount) > 0) {
          const sup = await db.prepare('SELECT name FROM suppliers WHERE id = ?').bind(po.supplier_id).first();
          const supName = sup ? sup.name : 'Nhà cung cấp';
          stmts.push(
            db.prepare(`
              INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
              VALUES (?, 'OUT', ?, 'Mua hàng / Trả nợ NCC', ?, ?, ?, ?)
            `).bind(
              genCode('TC'),
              po.paid_amount,
              po.payment_method || 'Chuyển khoản',
              existing.code,
              `Thanh toán tiền mua hàng cho ${supName} theo phiếu ${existing.code} (Đã cập nhật)`,
              customDate
            )
          );
        }

        stmts.push(stockGuard(db, ids));

        await runBatch(db, stmts, 'Không thể sửa phiếu: một số hàng đã bán nên tồn kho không đủ để hoàn lại');
        return json({ success: true, code: existing.code }, 200, origin);
      }

      if (is(/^\/api\/purchase_orders\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const items = (await db.prepare('SELECT product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?').bind(id).all()).results || [];
        const ids = [...new Set(items.map((i) => i.product_id))];
        const stmts = [
          ...items.map((i) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(i.quantity, i.product_id)),
          db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').bind(id),
          db.prepare('DELETE FROM chassis_units WHERE purchase_order_id = ?').bind(id),
          db.prepare('DELETE FROM purchase_orders WHERE id = ?').bind(id),
        ];
        if (ids.length) stmts.push(stockGuard(db, ids));
        await runBatch(db, stmts, 'Không thể xóa phiếu: một số hàng đã bán nên tồn kho không đủ để hoàn lại');
        return json({ success: true }, 200, origin);
      }

      // ===== 5. KHÁCH HÀNG =====
                  if (pathname === '/api/customers' && method === 'GET') {
        await ensureReturnSchema(db);
        const customers = (await db.prepare('SELECT * FROM customers ORDER BY id DESC').all()).results || [];
        const invs = (await db.prepare('SELECT customer_code, total, paid_amount FROM invoices').all()).results || [];
        let pays = [];
        if (await hasTable(db, 'customer_payments')) {
          pays = (await db.prepare('SELECT customer_code, amount FROM customer_payments').all()).results || [];
        }
        let rets = [];
        try {
          rets = (await db.prepare("SELECT customer_code, refund_amount, total_amount FROM return_orders WHERE status LIKE '%Hoàn Thành%'").all()).results || [];
        } catch (e) { console.error('customer returns failed', e); }
        const collected = await loadCollectionsByName(db);

        // Gom số liệu theo MÃ khách hàng
        const agg = new Map();
        const slot = (code) => {
          const k = code || '';
          if (!agg.has(k)) agg.set(k, { purchased: 0, invPaid: 0, pay: 0, retOffset: 0 });
          return agg.get(k);
        };
        invs.forEach((i) => { const a = slot(i.customer_code); a.purchased += Number(i.total) || 0; a.invPaid += Number(i.paid_amount) || 0; });
        pays.forEach((p) => { slot(p.customer_code).pay += Number(p.amount) || 0; });
        rets.forEach((r) => {
          const refunded = Number(r.refund_amount) || 0;
          const totalValue = Number(r.total_amount) || refunded;
          slot(r.customer_code).retOffset += Math.max(0, totalValue - refunded); // phần trả hàng trừ vào công nợ
        });

        return json(customers.map((c) => {
          const a = agg.get(c.code) || { purchased: 0, invPaid: 0, pay: 0, retOffset: 0 };
          const got = collected.get(c.code) || 0;
          return {
            ...c,
            total_purchased: a.purchased,
            total_paid: a.invPaid + a.pay + got,
            total_debt: a.purchased - a.invPaid - a.pay - a.retOffset - got,
          };
        }), 200, origin);
      }

      if (pathname === '/api/customers' && method === 'POST') {
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
        const code = str(b.code) || genCode('KH');
        try {
          await db.prepare('INSERT INTO customers (code, name, phone, address) VALUES (?,?,?,?)')
            .bind(code, name, str(b.phone) || null, str(b.address) || null).run();
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã khách hàng');
          throw err;
        }
        return json({ success: true, code }, 201, origin);
      }

      if (pathname === '/api/customers/import' && method === 'POST') {
        const { items = [] } = await request.json();
        let invalid = 0;
        const stmts = [];
        for (const it of items) {
          const name = str(it.name);
          if (!name) { invalid++; continue; }
          stmts.push(
            db.prepare(`INSERT INTO customers (code, name, phone, address) VALUES (?,?,?,?)
                        ON CONFLICT(code) DO UPDATE SET name = excluded.name, phone = excluded.phone, address = excluded.address`)
              .bind(str(it.code) || genCode('KH'), name, str(it.phone) || null, str(it.address) || null));
        }
        const r = await runImport(db, stmts);
        return json({ success: true, successCount: r.successCount, errorCount: r.errorCount + invalid }, 200, origin);
      }

      if (is(/^\/api\/customers\/\d+\/history$/, 'GET')) {
        const id = idOf(pathname);
        const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
        if (!customer) throw new HttpError(404, 'Không tìm thấy khách hàng');
        const invoices = (await db.prepare('SELECT * FROM invoices WHERE customer_code = ? ORDER BY id DESC').bind(customer.code).all()).results || [];
        let payments = [];
        if (await hasTable(db, 'customer_payments')) {
          payments = (await db.prepare('SELECT * FROM customer_payments WHERE customer_code = ? ORDER BY id DESC').bind(customer.code).all()).results || [];
        }
        return json({ customer, invoices: withCollected(invoices, await loadCollectionsByName(db)), payments }, 200, origin);
      }
      if (is(/^\/api\/customers\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
        const current = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
        if (!current) throw new HttpError(404, 'Không tìm thấy khách hàng');

        const newCode = str(b.code) || current.code;
        const stmts = [
          db.prepare('UPDATE customers SET code = ?, name = ?, phone = ?, address = ? WHERE id = ?')
            .bind(newCode, name, str(b.phone) || null, str(b.address) || null, id),
        ];
        // Đổi tên hoặc mã khách: cập nhật lại chứng từ của ĐÚNG khách này (theo mã cũ)
        const docTables = ['invoices', 'orders', 'return_orders'];
        if (await hasTable(db, 'customer_payments')) docTables.push('customer_payments');
        for (const t of docTables) {
          stmts.push(db.prepare(`UPDATE ${t} SET customer_name = ?, customer_code = ? WHERE customer_code = ?`).bind(name, newCode, current.code));
        }
        if (newCode !== current.code) {
          // Phiếu thu chi nhập tay đang ghi mã khách cũ trong ô chứng từ
          stmts.push(db.prepare('UPDATE cash_books SET reference_code = ? WHERE reference_code = ?').bind(newCode, current.code));
        }
        try { await db.batch(stmts); }
        catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã khách hàng');
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/customers\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const c = await db.prepare('SELECT name, code FROM customers WHERE id = ?').bind(id).first();
        if (!c) throw new HttpError(404, 'Không tìm thấy khách hàng');
        const used = await db.prepare('SELECT (SELECT COUNT(*) FROM invoices WHERE customer_code = ?1) + (SELECT COUNT(*) FROM orders WHERE customer_code = ?1) AS n').bind(c.code).first();
        if (used?.n > 0) throw new HttpError(409, 'Khách hàng đã có đơn hàng/phiếu bán nên không thể xóa');
        await db.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // GET /api/reports/inventory-summary — Báo cáo Xuất Nhập Tồn theo khoảng thời gian
      // [FIX] Tính giá trị theo BÌNH QUÂN GIA QUYỀN CUỐI KỲ (xem buildInventoryReport):
      //   Tồn đầu + Nhập − Xuất = Tồn cuối (cả số lượng lẫn giá trị đều khớp)
      if (pathname === '/api/reports/inventory-summary' && method === 'GET') {
        const urlObj = new URL(request.url);
        const startDate = urlObj.searchParams.get('startDate') || '2025-01-01';
        const endDate = urlObj.searchParams.get('endDate') || '2030-12-31';
        const search = (urlObj.searchParams.get('search') || '').trim().toLowerCase();

        const reportData = await buildInventoryReport(db, startDate, endDate);

        // Chỉ hiển thị sản phẩm có phát sinh và khớp từ khóa tìm kiếm
        const activeItems = reportData
          .filter((item) => {
            const hasActivity = item.openingQty !== 0 || item.importQty !== 0 || item.exportQty !== 0 || item.closingQty !== 0;
            const matchesSearch = !search || item.code.toLowerCase().includes(search) || item.name.toLowerCase().includes(search);
            return hasActivity && matchesSearch;
          })
          // Bỏ các trường phụ chỉ dùng nội bộ cho báo cáo lãi lỗ
          .map(({ avgCost, soldQty, returnedQty, ...rest }) => rest);

        // Tính tổng cộng
        const totals = activeItems.reduce((acc, item) => {
          acc.openingQty += item.openingQty;
          acc.openingVal += item.openingVal;
          acc.importQty += item.importQty;
          acc.importVal += item.importVal;
          acc.exportQty += item.exportQty;
          acc.exportVal += item.exportVal;
          acc.closingQty += item.closingQty;
          acc.closingVal += item.closingVal;
          return acc;
        }, { openingQty: 0, openingVal: 0, importQty: 0, importVal: 0, exportQty: 0, exportVal: 0, closingQty: 0, closingVal: 0 });

        return json({
          success: true,
          summary: {
            totalOpeningVal: totals.openingVal,
            totalImportVal: totals.importVal,
            totalExportVal: totals.exportVal,
            totalClosingVal: totals.closingVal
          },
          totals,
          items: activeItems
        }, 200, origin);
      }

      // ===== BÁO CÁO KẾT QUẢ KINH DOANH =====
      if (pathname === '/api/reports/profit-loss' && method === 'GET') {
        await ensureReturnSchema(db);
        const urlObj = new URL(request.url);
        const startDate = urlObj.searchParams.get('startDate') || '2025-01-01';
        const endDate = urlObj.searchParams.get('endDate') || '2025-12-31';

        // 1. Doanh thu bán hàng trong kỳ
        const revRes = await db.prepare(`
          SELECT COALESCE(SUM(total), 0) AS gross FROM invoices
          WHERE date(created_at) >= ? AND date(created_at) <= ?
        `).bind(startDate, endDate).first();
        const grossRevenue = Number(revRes?.gross) || 0;

        // 2. Các khoản giảm trừ = tiền hoàn của các phiếu trả hàng đã hoàn thành trong kỳ
        const retRes = await db.prepare(`
          SELECT COALESCE(SUM(COALESCE(NULLIF(total_amount, 0), refund_amount)), 0) AS refunded FROM return_orders
          WHERE date(return_date) >= ? AND date(return_date) <= ?
            AND (status LIKE '%Hoàn Thành%' OR status LIKE '%Đã hoàn thành%')
        `).bind(startDate, endDate).first();
        const returnDeductions = Number(retRes?.refunded) || 0;
        const netRevenue = grossRevenue - returnDeductions;

        // 3. Giá vốn hàng bán = (SL bán − SL khách trả lại) × đơn giá bình quân gia quyền cuối kỳ
        //    Dùng chung hàm với báo cáo Xuất Nhập Tồn nên giá vốn luôn khớp với giá trị xuất kho
        const invReport = await buildInventoryReport(db, startDate, endDate);
        let cogs = 0;
        for (const r of invReport) {
          cogs += (r.soldQty - r.returnedQty) * r.avgCost;
        }
        cogs = Math.round(Math.max(0, cogs));
        const grossProfit = netRevenue - cogs;

        // 4. Chi phí hoạt động lấy từ Sổ quỹ (phiếu chi theo danh mục)
        const expRes = await db.prepare(`
          SELECT category, COALESCE(SUM(amount), 0) AS amt FROM cash_books
          WHERE type = 'OUT' AND date(created_at) >= ? AND date(created_at) <= ?
          GROUP BY category
        `).bind(startDate, endDate).all();

        const expenses = { shipping: 0, tax: 0, salary: 0, other: 0, total: 0 };
        (expRes.results || []).forEach((row) => {
          const amt = Number(row.amt) || 0;
          if (row.category === 'Chi phí vận chuyển') expenses.shipping += amt;
          else if (row.category === 'Chi thuế') expenses.tax += amt;
          else if (row.category === 'Chi lương nhân viên') expenses.salary += amt;
          else if (row.category === 'Chi phí khác') expenses.other += amt;
          // Các danh mục "Mua hàng / Trả nợ NCC", "Chi hoàn trả khách hàng" không phải chi phí hoạt động
        });
        expenses.total = expenses.shipping + expenses.tax + expenses.salary + expenses.other;

        const netProfit = grossProfit - expenses.total;

        return json({
          success: true,
          data: {
            grossRevenue,                    // Doanh thu bán hàng
            totalDiscount: returnDeductions, // Các khoản giảm trừ (hiển thị ở giao diện)
            returnDeductions,                // Các khoản giảm trừ (trả lại)
            netRevenue,                      // Doanh thu thuần
            cogs,                            // Giá vốn hàng bán (đã trừ giá vốn hàng bị trả lại)
            grossProfit,                     // Lợi nhuận gộp
            expenses,                        // Chi phí hoạt động
            netProfit                        // Lợi nhuận thuần
          }
        }, 200, origin);
      }

      // ===== PHIẾU BẢO HÀNH =====
if (pathname === '/api/warranties' && method === 'GET') {
  await ensureWarrantySchema(db);
  const { results } = await db.prepare('SELECT * FROM warranties ORDER BY created_at DESC, id DESC').all();
  return json((results || []).map(wRow), 200, origin);
}

if (pathname === '/api/warranties' && method === 'POST') {
  await ensureWarrantySchema(db);
  const b = await request.json();
  const vals = warrantyFields(b);
  try {
    const r = await db.prepare(
      `INSERT INTO warranties (code, invoice_code, customer_name, customer_phone, address, purchase_date, duration, unit, expiry_date, note, items, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(...vals, isoDate(b.created_at)).run();
    return json({ success: true, id: r.meta?.last_row_id }, 201, origin);
  } catch (err) {
    if (isUnique(err)) throw new HttpError(400, 'Mã phiếu bảo hành đã tồn tại');
    throw err;
  }
}

if (is(/^\/api\/warranties\/\d+$/, 'PUT')) {
  await ensureWarrantySchema(db);
  const id = idOf(pathname);
  const vals = warrantyFields(await request.json());
  try {
    const r = await db.prepare(
      `UPDATE warranties SET code=?, invoice_code=?, customer_name=?, customer_phone=?, address=?, purchase_date=?, duration=?, unit=?, expiry_date=?, note=?, items=? WHERE id=?`
    ).bind(...vals, id).run();
    if (!r.meta?.changes) throw new HttpError(404, 'Không tìm thấy phiếu bảo hành');
  } catch (err) {
    if (isUnique(err)) throw new HttpError(400, 'Mã phiếu bảo hành đã tồn tại');
    throw err;
  }
  return json({ success: true }, 200, origin);
}

if (is(/^\/api\/warranties\/\d+$/, 'DELETE')) {
  await ensureWarrantySchema(db);
  await db.prepare('DELETE FROM warranties WHERE id = ?').bind(idOf(pathname)).run();
  return json({ success: true }, 200, origin);
}

      // ===== DASHBOARD =====
if (pathname === '/api/reports/dashboard' && method === 'GET') {
  await ensureReturnSchema(db);
  const u = new URL(request.url);
  const startDate = dateOnly(u.searchParams.get('startDate'));
  const endDate = dateOnly(u.searchParams.get('endDate'));
  const topStart = dateOnly(u.searchParams.get('topStart')) || startDate; // kỳ xếp hạng top SP / top KH
  const topEnd = dateOnly(u.searchParams.get('topEnd')) || endDate;
  const sortBy = u.searchParams.get('sort') === 'qty' ? 'qty' : 'value'; // chỉ nhận 2 giá trị này
  if (!startDate || !endDate) throw new HttpError(400, 'Thiếu khoảng ngày');

  // Doanh thu + số đơn theo từng ngày
  const daily = (await db.prepare(`
    SELECT date(created_at) AS d, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
    FROM invoices WHERE date(created_at) >= ? AND date(created_at) <= ?
    GROUP BY date(created_at)
  `).bind(startDate, endDate).all()).results || [];
  const revenue = daily.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const orders = daily.reduce((s, r) => s + (Number(r.orders) || 0), 0);

  // Lợi nhuận = doanh thu - tiền hàng trả lại - giá vốn (cùng cách tính với báo cáo Kết quả kinh doanh)
  const retRes = await db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(total_amount, 0), refund_amount)), 0) AS refunded FROM return_orders
    WHERE date(return_date) >= ? AND date(return_date) <= ?
      AND (status LIKE '%Hoàn Thành%' OR status LIKE '%Đã hoàn thành%')
  `).bind(startDate, endDate).first();
  const returnDeductions = Number(retRes?.refunded) || 0;
  const invReport = await buildInventoryReport(db, startDate, endDate);
  let cogs = 0;
  for (const r of invReport) cogs += (r.soldQty - r.returnedQty) * r.avgCost;
  const profit = Math.round(revenue - returnDeductions - Math.max(0, cogs));

    // Đơn hàng gần nhất (đã trừ tiền thu nợ nhập trong Thu chi)
  const allInv = (await db.prepare('SELECT id, code, customer_name, customer_code, total, paid_amount, debt, created_at FROM invoices').all()).results || [];
  const recent = withCollected(allInv, await loadCollectionsByName(db))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id))
    .slice(0, 8);

   // Top 10 sản phẩm bán chạy (theo số lượng hoặc doanh thu)
  const prodOrder = sortBy === 'qty' ? 'qty DESC, revenue DESC' : 'revenue DESC, qty DESC';
  const topProducts = (await db.prepare(`
    SELECT ii.product_id AS id, COALESCE(p.sku, '') AS sku, COALESCE(p.name, 'Sản phẩm đã xóa') AS name,
           SUM(ii.quantity) AS qty, SUM(ii.total) AS revenue
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN products p ON ii.product_id = p.id
    WHERE date(i.created_at) >= ? AND date(i.created_at) <= ?
    GROUP BY ii.product_id
    ORDER BY ${prodOrder}
    LIMIT 10
  `).bind(topStart, topEnd).all()).results || [];

   // Top 10 khách hàng (theo tổng tiền hoặc tổng số sản phẩm đã mua, bỏ "Khách lẻ")
  const cusOrder = sortBy === 'qty' ? 'qty DESC, total DESC' : 'total DESC, qty DESC';
  const topCustomers = (await db.prepare(`
    SELECT COALESCE(NULLIF(i.customer_code, ''), i.customer_name) AS ckey,
           MAX(i.customer_name) AS name,
           MAX(i.customer_code) AS code,
           COUNT(*) AS orders,
           COALESCE(SUM(i.total), 0) AS total,
           COALESCE(SUM((SELECT SUM(ii.quantity) FROM invoice_items ii WHERE ii.invoice_id = i.id)), 0) AS qty
    FROM invoices i
    WHERE date(i.created_at) >= ? AND date(i.created_at) <= ?
      AND i.customer_name NOT LIKE 'Khách lẻ%'
    GROUP BY ckey
    ORDER BY ${cusOrder}
    LIMIT 10
  `).bind(topStart, topEnd).all()).results || [];

  return json({ success: true, data: { revenue, profit, orders, daily, recent, topProducts, topCustomers } }, 200, origin);
}

      // ===== BÁO CÁO DOANH THU CHI TIẾT (theo từng phiếu bán + từng sản phẩm) =====
if (pathname === '/api/reports/revenue-detail' && method === 'GET') {
  await ensureReturnSchema(db);
  await ensureChassisColumns(db);
  const u = new URL(request.url);
  const startDate = dateOnly(u.searchParams.get('startDate')) || '2000-01-01';
  const endDate = dateOnly(u.searchParams.get('endDate')) || '2100-12-31';

  // Đơn giá vốn bình quân gia quyền của kỳ (cùng hàm với báo cáo X-N-T / Kết quả kinh doanh)
  const report = await buildInventoryReport(db, startDate, endDate);
  const unitCost = new Map(report.map((r) => [String(r.id), Number(r.avgCost) || 0]));

  const invs = (await db.prepare(`
    SELECT i.id, i.code, i.customer_name, i.created_at, i.total, i.paid_amount, i.debt,
                      i.customer_code AS customer_code
    FROM invoices i
    WHERE date(i.created_at) >= ? AND date(i.created_at) <= ?
    ORDER BY i.created_at DESC, i.id DESC
  `).bind(startDate, endDate).all()).results || [];

  const lineRows = (await db.prepare(`
    SELECT ii.invoice_id, ii.product_id, ii.quantity, ii.price, ii.discount, ii.total, ii.chassis_color,
           p.name AS product_name, p.sku
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN products p ON ii.product_id = p.id
    WHERE date(i.created_at) >= ? AND date(i.created_at) <= ?
    ORDER BY ii.id
  `).bind(startDate, endDate).all()).results || [];

  const byInvoice = new Map();
  for (const l of lineRows) {
    const qty = Number(l.quantity) || 0;
    const uc = unitCost.get(String(l.product_id)) || 0;
    const revenue = Number(l.total) || 0;
    const cost = Math.round(qty * uc);
    const item = {
      product_id: l.product_id,
      sku: l.sku || '',
      name: l.product_name || 'Sản phẩm đã xóa',
      detail: l.chassis_color || '',
      quantity: qty,
      price: Number(l.price) || 0,
      discount: Number(l.discount) || 0,
      revenue,
      unit_cost: Math.round(uc),
      cost,
      profit: revenue - cost,
    };
    if (!byInvoice.has(l.invoice_id)) byInvoice.set(l.invoice_id, []);
    byInvoice.get(l.invoice_id).push(item);
  }

  const invoices = invs.map((inv) => {
    const items = byInvoice.get(inv.id) || [];
    const cost = items.reduce((s, x) => s + x.cost, 0);
    const revenue = Number(inv.total) || 0;
    return { ...inv, revenue, cost, profit: revenue - cost, items };
  });

  const summary = invoices.reduce(
    (a, r) => ({ revenue: a.revenue + r.revenue, cost: a.cost + r.cost, profit: a.profit + r.profit, count: a.count + 1 }),
    { revenue: 0, cost: 0, profit: 0, count: 0 }
  );

  return json({ success: true, data: { summary, invoices } }, 200, origin);
}
            // ===== TÍNH GIÁ NHẬP =====
      if (pathname === '/api/import-costs' && method === 'GET') {
        await ensureCostSchema(db);
        const { results } = await db.prepare('SELECT data FROM import_costs ORDER BY rowid DESC').all();
        const rows = (results || [])
          .map((r) => { try { return JSON.parse(r.data); } catch (e) { return null; } })
          .filter(Boolean);
        const def = await db.prepare("SELECT value FROM app_settings WHERE key = 'import_cost_defaults'").first();
        let defaults = null;
        try { defaults = def ? JSON.parse(def.value) : null; } catch (e) { /* bỏ qua */ }
        return json({ success: true, rows, defaults }, 200, origin);
      }

      if (pathname === '/api/import-cost-defaults' && method === 'PUT') {
        await ensureCostSchema(db);
        const b = await request.json();
        await db.prepare(
          `INSERT INTO app_settings (key, value) VALUES ('import_cost_defaults', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).bind(JSON.stringify(b || {})).run();
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/import-costs\/[A-Za-z0-9_-]+$/, 'PUT')) {
        await ensureCostSchema(db);
        const id = pathname.split('/')[3];
        const b = await request.json();
        if (!b || typeof b !== 'object') throw new HttpError(400, 'Dữ liệu không hợp lệ');
        await db.prepare(
          `INSERT INTO import_costs (id, data, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
        ).bind(id, JSON.stringify({ ...b, id }), new Date().toISOString()).run();
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/import-costs\/[A-Za-z0-9_-]+$/, 'DELETE')) {
        await ensureCostSchema(db);
        await db.prepare('DELETE FROM import_costs WHERE id = ?').bind(pathname.split('/')[3]).run();
        return json({ success: true }, 200, origin);
      }

      // ===== DANH SÁCH SỐ KHUNG / SỐ SƯỜN =====
      if (pathname === '/api/chassis-list' && method === 'GET') {
        await ensureChassisColumns(db);
        await ensureUnitSchema(db);

        // 1. Xe đã ghi số khung / số sườn lúc nhập hàng
        const units = (await db.prepare(`
          SELECT u.id, u.product_id, u.chassis, u.frame, u.purchase_order_id, u.purchase_code,
                 s.name AS supplier_name, p.name AS product_name, p.sku
          FROM chassis_units u
          LEFT JOIN purchase_orders po ON u.purchase_order_id = po.id
          LEFT JOIN suppliers s ON po.supplier_id = s.id
          LEFT JOIN products p ON u.product_id = p.id
          ORDER BY u.id DESC
        `).all()).results || [];

        // 2. Dòng hàng của phiếu bán có ghi số khung / số sườn
        const soldRaw = (await db.prepare(`
          SELECT ii.id, ii.product_id, ii.chassis_color,
                 i.id AS invoice_id, i.code AS invoice_code, i.created_at AS sold_at,
                 i.customer_name, i.customer_code,
                 p.name AS product_name, p.sku
          FROM invoice_items ii
          JOIN invoices i ON ii.invoice_id = i.id
          LEFT JOIN products p ON ii.product_id = p.id
          WHERE COALESCE(ii.chassis_color, '') <> ''
          ORDER BY i.created_at DESC, ii.id DESC
        `).all()).results || [];
        const sold = [];
        for (const s of soldRaw) {
          const d = parseChassisText(s.chassis_color);
          if (!d.chassis && !d.frame) continue; // dòng chỉ có màu / ghi chú thì bỏ qua
          sold.push({ ...s, chassis: d.chassis, frame: d.frame });
        }
        const soldByChassis = new Map();
        const soldByFrame = new Map();
        for (const s of sold) {
          const ck = normSerial(s.chassis);
          const fk = normSerial(s.frame);
          if (ck && !soldByChassis.has(ck)) soldByChassis.set(ck, s);
          if (fk && !soldByFrame.has(fk)) soldByFrame.set(fk, s);
        }

        const rows = [];
        const matched = new Set();

        // Mỗi xe trong sổ nhập: ghép với phiếu bán có cùng số khung (hoặc số sườn)
        for (const u of units) {
          const ck = normSerial(u.chassis);
          const fk = normSerial(u.frame);
          const s = (ck && soldByChassis.get(ck)) || (fk && soldByFrame.get(fk)) || null;
          if (s) matched.add(s.id);
          rows.push({
            key: 'u' + u.id,
            chassis: u.chassis || '',
            frame: u.frame || '',
            product_id: u.product_id,
            product_name: u.product_name || 'Sản phẩm đã xóa',
            sku: u.sku || '',
            purchase_id: u.purchase_order_id,
            purchase_code: u.purchase_code || '',
            supplier_name: u.supplier_name || '',
            estimated: false,
            invoice_id: s ? s.invoice_id : null,
            invoice_code: s ? s.invoice_code : '',
            customer_code: s ? s.customer_code || '' : '',
            customer_name: s ? s.customer_name || '' : '',
            sold_at: s ? s.sold_at : '',
          });
        }

        // 3. Xe đã bán nhưng chưa có trong sổ nhập (phiếu nhập cũ): ước tính phiếu nhập gần nhất trước ngày bán
        const pur = (await db.prepare(`
          SELECT poi.product_id, po.id AS purchase_id, po.code, po.created_at, s.name AS supplier_name
          FROM purchase_order_items poi
          JOIN purchase_orders po ON poi.purchase_order_id = po.id
          LEFT JOIN suppliers s ON po.supplier_id = s.id
          ORDER BY po.created_at ASC, po.id ASC
        `).all()).results || [];
        const lots = new Map();
        for (const x of pur) {
          const key = String(x.product_id);
          if (!lots.has(key)) lots.set(key, []);
          lots.get(key).push(x);
        }
        for (const s of sold) {
          if (matched.has(s.id)) continue;
          const soldDay = dateOnly(s.sold_at);
          let pick = null;
          for (const x of lots.get(String(s.product_id)) || []) {
            if (dateOnly(x.created_at) <= soldDay) pick = x; else break;
          }
          rows.push({
            key: 's' + s.id,
            chassis: s.chassis,
            frame: s.frame,
            product_id: s.product_id,
            product_name: s.product_name || 'Sản phẩm đã xóa',
            sku: s.sku || '',
            purchase_id: pick ? pick.purchase_id : null,
            purchase_code: pick ? pick.code : '',
            supplier_name: pick ? pick.supplier_name || '' : '',
            estimated: true,
            invoice_id: s.invoice_id,
            invoice_code: s.invoice_code,
            customer_code: s.customer_code || '',
            customer_name: s.customer_name || '',
            sold_at: s.sold_at,
          });
        }

        return json({ success: true, rows }, 200, origin);
      }
      
      // ===== Route /api không tồn tại: trả 404 JSON, KHÔNG rơi xuống ASSETS =====
      // (trước đây request lạ như PUT /api/purchase_orders/1 nhận về index.html với status 200 -> frontend báo "thành công" giả)
      if (pathname.startsWith('/api/')) return json({ error: 'Không tìm thấy API' }, 404, origin);

      // Phục vụ giao diện Frontend
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return json({ error: 'Không tìm thấy' }, 404, origin);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
      console.error(e);
      return json({ error: 'Lỗi chi tiết: ' + e.message }, 500, origin);
    }
  },
};
