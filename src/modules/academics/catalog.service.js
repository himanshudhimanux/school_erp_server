import { SchoolClass, Subject } from './academics.models.js';
import { getClassOr404, getSubjectOr404, escapeRegex } from './academics.common.js';
import { paginate } from '../../utils/pagination.js';
import { assertDeletable } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';

/** Shared CRUD for the school-wide catalogues: classes and subjects. */
function catalog({ Model, entity, label, getOr404, defaultSort }) {
  return {
    list(schoolId, { page, limit, status, search, sort, type }) {
      const filter = { schoolId };
      if (status) filter.status = status;
      if (type) filter.type = type;
      if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ name: rx }, { code: rx }];
      }
      return paginate(Model, filter, { page, limit, sort: sort || defaultSort });
    },

    get: (schoolId, id) => getOr404(schoolId, id),

    async create(tenant, data, ctx) {
      const doc = await Model.create({ ...data, schoolId: tenant.schoolId, createdBy: ctx.actorId });
      await recordAudit({ ...ctx, action: `${entity}.created`, entityType: Model.modelName, entityId: doc._id, metadata: { code: doc.code, name: doc.name } });
      return doc;
    },

    async update(tenant, id, data, ctx) {
      const doc = await getOr404(tenant.schoolId, id);
      doc.set({ ...data, updatedBy: ctx.actorId });
      await doc.save();
      await recordAudit({ ...ctx, action: `${entity}.updated`, entityType: Model.modelName, entityId: doc._id, metadata: { changed: Object.keys(data) } });
      return doc;
    },

    async remove(tenant, id, ctx) {
      const doc = await getOr404(tenant.schoolId, id);
      await assertDeletable(entity, tenant.schoolId, doc._id, label);
      await doc.softDelete(ctx.actorId);
      await recordAudit({ ...ctx, action: `${entity}.deleted`, entityType: Model.modelName, entityId: doc._id, metadata: { code: doc.code, name: doc.name } });
    },
  };
}

export const classes = catalog({ Model: SchoolClass, entity: 'class', label: 'class', getOr404: getClassOr404, defaultSort: 'order name' });
export const subjects = catalog({ Model: Subject, entity: 'subject', label: 'subject', getOr404: getSubjectOr404, defaultSort: 'name' });
