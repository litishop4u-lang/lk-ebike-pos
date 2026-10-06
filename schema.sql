-- D1 (SQLite) schema cho POS xe đạp điện
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  price      INTEGER NOT NULL CHECK (price >= 0),          -- VND, số nguyên
  stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0), -- CHECK = chốt chặn chống bán âm kho
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Đơn đặt hàng: KHÔNG trừ kho
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,                      -- DH-xxxx
  customer_name  TEXT NOT NULL,
  customer_phone TEXT,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','invoiced','cancelled')),
  total          INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL
);

-- Phiếu bán hàng: CÓ trừ kho
CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,                      -- HD-xxxx
  order_id       INTEGER REFERENCES orders(id),             -- tùy chọn: xuất từ đơn đặt hàng
  customer_name  TEXT NOT NULL,
  customer_phone TEXT,
  note           TEXT,
  total          INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- Dữ liệu mẫu
INSERT OR IGNORE INTO products (sku, name, price, stock) VALUES
 ('XDD-A1', 'Xe đạp điện Aima A1', 9500000, 12),
 ('XDD-V2', 'Xe đạp điện Vinfast Feliz Mini', 14900000, 5),
 ('ACQ-48', 'Bình ắc quy 48V', 1800000, 30);
