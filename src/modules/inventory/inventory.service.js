import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';
import { escapeRegex } from '../common/person.schema.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const { ObjectId } = mongoose.Schema.Types;

/* ------------------------------ models ------------------------------ */

/** A stock item. `quantity` changes only through stock movements (atomic, never below zero). */
const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    category: { type: String, trim: true, maxlength: 60 },
    unit: { type: String, trim: true, maxlength: 20, default: 'pcs' },
    quantity: { type: Number, min: 0, default: 0 },
    reorderLevel: { type: Number, min: 0, default: 0 },
    location: { type: String, trim: true, maxlength: 80 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
itemSchema.plugin(tenantPlugin);
itemSchema.plugin(softDeletePlugin);
itemSchema.index({ schoolId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
itemSchema.index({ schoolId: 1, category: 1 });
export const InventoryItem = mongoose.model('InventoryItem', itemSchema);

export const MOVEMENT_TYPES = ['in', 'out', 'adjust'];

/** Append-only stock ledger: every change to an item's quantity, with the balance after it. */
const movementSchema = new mongoose.Schema(
  {
    itemId: { type: ObjectId, ref: 'InventoryItem', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    // Signed change applied to quantity (+ for in, − for out, either for adjust).
    change: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, min: 0, default: null },
    reference: { type: String, trim: true, maxlength: 80 },
    issuedTo: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 300 },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
movementSchema.plugin(tenantPlugin);
movementSchema.index({ schoolId: 1, itemId: 1, createdAt: -1 });
movementSchema.index({ schoolId: 1, createdAt: -1 });
export const StockMovement = mongoose.model('StockMovement', movementSchema);

/* ------------------------------ items ------------------------------ */

export async function listItems(tenant, { page, limit, search, category, lowStock, status }) {
  const filter = { schoolId: tenant.schoolId };
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (lowStock) filter.$expr = { $lte: ['$quantity', '$reorderLevel'] };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { location: rx }];
  }
  const [items, total, categories, low] = await Promise.all([
    InventoryItem.find(filter).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    InventoryItem.countDocuments(filter),
    InventoryItem.distinct('category', { schoolId: tenant.schoolId }),
    InventoryItem.countDocuments({ schoolId: tenant.schoolId, status: 'active', $expr: { $lte: ['$quantity', '$reorderLevel'] } }),
  ]);
  return { items: items.map((i) => ({ ...i, lowStock: i.quantity <= i.reorderLevel })), meta: { page, limit, total, totalPages: Math.ceil(total / limit), categories: categories.filter(Boolean).sort(), lowStockCount: low } };
}

async function getItemDoc(schoolId, id) {
  const i = await InventoryItem.findOne({ _id: id, schoolId });
  if (!i) throw ApiError.notFound('Item not found');
  return i;
}

export async function createItem(tenant, { openingQuantity = 0, ...data }, ctx) {
  let item;
  try {
    item = await InventoryItem.create({ ...data, quantity: openingQuantity, schoolId: tenant.schoolId, createdBy: ctx.actorId });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('An item with this code already exists', { code: 'CODE_TAKEN' });
    throw err;
  }
  if (openingQuantity) await StockMovement.create({ schoolId: tenant.schoolId, itemId: item._id, type: 'in', change: openingQuantity, balanceAfter: openingQuantity, note: 'Opening stock', by: ctx.actorId });
  await recordAudit({ ...ctx, action: 'inventory.item_created', entityType: 'InventoryItem', entityId: item._id, metadata: { code: item.code, openingQuantity } });
  return item;
}

export async function updateItem(tenant, id, data, ctx) {
  const item = await getItemDoc(tenant.schoolId, id);
  item.set(data);
  try {
    await item.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('An item with this code already exists', { code: 'CODE_TAKEN' });
    throw err;
  }
  await recordAudit({ ...ctx, action: 'inventory.item_updated', entityType: 'InventoryItem', entityId: item._id, metadata: { changed: Object.keys(data) } });
  return item;
}

export async function deleteItem(tenant, id, ctx) {
  const item = await getItemDoc(tenant.schoolId, id);
  if (item.quantity > 0) throw ApiError.conflict('Issue or adjust the remaining stock to zero before removing the item', { code: 'ITEM_HAS_STOCK' });
  await item.softDelete(ctx.actorId);
  await recordAudit({ ...ctx, action: 'inventory.item_deleted', entityType: 'InventoryItem', entityId: item._id, metadata: { code: item.code } });
}

/* ------------------------------ stock ------------------------------ */

/**
 * Records stock in, out or a count adjustment. The quantity changes atomically and never goes
 * below zero (`409 INSUFFICIENT_STOCK`). Adjustments take the counted quantity.
 */
export async function moveStock(tenant, itemId, { type, quantity, countedQuantity, unitCost, reference, issuedTo, note }, ctx) {
  const schoolId = tenant.schoolId;
  const item = await getItemDoc(schoolId, itemId);
  if (item.status !== 'active') throw ApiError.badRequest('This item is inactive', { code: 'ITEM_INACTIVE' });
  let updated;
  if (type === 'adjust') {
    updated = await InventoryItem.findOneAndUpdate({ _id: item._id, schoolId, quantity: item.quantity }, { $set: { quantity: countedQuantity } }, { returnDocument: 'after' });
    if (!updated) throw ApiError.conflict('Stock changed while you were counting. Reload and try again.', { code: 'STOCK_CHANGED' });
  } else {
    const change = type === 'in' ? quantity : -quantity;
    updated = await InventoryItem.findOneAndUpdate({ _id: item._id, schoolId, ...(type === 'out' ? { quantity: { $gte: quantity } } : {}) }, { $inc: { quantity: change } }, { returnDocument: 'after' });
    if (!updated) throw ApiError.conflict(`Only ${item.quantity} ${item.unit} in stock`, { code: 'INSUFFICIENT_STOCK', details: { available: item.quantity } });
  }
  const change = type === 'adjust' ? countedQuantity - item.quantity : type === 'in' ? quantity : -quantity;
  const movement = await StockMovement.create({ schoolId, itemId: item._id, type, change, balanceAfter: updated.quantity, unitCost: type === 'in' ? unitCost ?? null : null, reference, issuedTo, note, by: ctx.actorId });
  await recordAudit({ ...ctx, action: `inventory.stock_${type}`, entityType: 'InventoryItem', entityId: item._id, metadata: { change, balanceAfter: updated.quantity } });
  return { item: { ...updated.toObject(), lowStock: updated.quantity <= updated.reorderLevel }, movement };
}

export async function listMovements(tenant, { page, limit, itemId, type }) {
  const filter = { schoolId: tenant.schoolId };
  if (itemId) filter.itemId = itemId;
  if (type) filter.type = type;
  const [rows, total] = await Promise.all([
    StockMovement.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('by', 'name').lean(),
    StockMovement.countDocuments(filter),
  ]);
  const items = await InventoryItem.find({ schoolId: tenant.schoolId, _id: { $in: rows.map((r) => r.itemId) } }).setOptions({ withDeleted: true }).select('name code unit').lean();
  const byId = new Map(items.map((i) => [String(i._id), i]));
  return { items: rows.map((r) => ({ ...r, item: byId.get(String(r.itemId)) || null, by: r.by?.name ?? null })), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
