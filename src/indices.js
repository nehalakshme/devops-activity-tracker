import { es } from './esClient.js';

// Reusable text-with-keyword-subfield mapping.
const textKeyword = {
  type: 'text',
  fields: { keyword: { type: 'keyword' } },
};

// Ownership fields present on every entity.
const ownerFields = {
  created_by: { type: 'keyword' }, // username of creator
  assigned_to: { type: 'keyword' }, // username, "common", or null
};

// Relationship + tagging fields shared by task/pipeline/poc.
const linkFields = {
  parent_id: { type: 'keyword' },
  parent_type: { type: 'keyword' },
  blocks: { type: 'keyword' },
  blocked_by: { type: 'keyword' },
  relationship_label: { type: 'keyword' },
  tags: { type: 'keyword' },
  recurrence_rule_id: { type: 'keyword' },
  ...ownerFields,
};

export const INDICES = {
  checklist_items: {
    properties: {
      category: { type: 'keyword' },
      label: textKeyword,
      checked: { type: 'boolean' },
      date: { type: 'date', format: 'yyyy-MM-dd' },
      created_at: { type: 'date' },
      ...ownerFields,
    },
  },

  daily_tasks: {
    properties: {
      task_name: textKeyword,
      environment: { type: 'keyword' },
      entry_time: { type: 'date' },
      todo_description: { type: 'text' },
      who_asked: { type: 'keyword' },
      priority: { type: 'keyword' },
      status: { type: 'keyword' },
      due_date: { type: 'date', format: 'yyyy-MM-dd' }, // optional SLA target
      created_at: { type: 'date' },
      completed_at: { type: 'date' },
      ...linkFields,
    },
  },

  pipelines: {
    properties: {
      type: { type: 'keyword' },
      stage: { type: 'keyword' },
      pipeline_name: textKeyword,
      flow: { type: 'text' },
      status: { type: 'keyword' },
      cicd_triggered: { type: 'boolean' },
      run_date: { type: 'date' },
      created_at: { type: 'date' },
      completed_at: { type: 'date' },
      ...linkFields,
    },
  },

  maintenance: {
    properties: {
      environment: { type: 'keyword' },
      version: { type: 'keyword' },
      release_version: { type: 'keyword' },
      notes: { type: 'text' },
      date: { type: 'date', format: 'yyyy-MM-dd' },
      created_at: { type: 'date' },
      tags: { type: 'keyword' },
      recurrence_rule_id: { type: 'keyword' },
      ...ownerFields,
    },
  },

  // Per-environment pipeline checklist (dev/test/qa/production → API/UI categories).
  pipeline_checks: {
    properties: {
      environment: { type: 'keyword' }, // dev | test | qa | production
      category: { type: 'keyword' }, // API-Services | UI-Services
      label: textKeyword,
      checked: { type: 'boolean' },
      created_at: { type: 'date' },
      ...ownerFields,
    },
  },

  pocs: {
    properties: {
      title: textKeyword,
      concept_description: { type: 'text' },
      status: { type: 'keyword' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
      ...linkFields,
    },
  },

  timeline_events: {
    properties: {
      event_type: { type: 'keyword' },
      event_title: textKeyword,
      event_description: { type: 'text' },
      related_id: { type: 'keyword' },
      completed_at: { type: 'date' },
      date: { type: 'date', format: 'yyyy-MM-dd' },
    },
  },

  // ---- Feature 1: Activity log / audit trail ----
  activity_log: {
    properties: {
      entity_type: { type: 'keyword' }, // task | pipeline | maintenance | poc | checklist
      entity_id: { type: 'keyword' },
      action: { type: 'keyword' }, // created | status_changed | priority_changed | assigned | commented | edited | deleted
      field_changed: { type: 'keyword' },
      old_value: { type: 'keyword' },
      new_value: { type: 'keyword' },
      reason_note: { type: 'text' },
      actor: { type: 'keyword' },
      timestamp: { type: 'date' },
    },
  },

  // ---- Feature 2: Relationships ----
  relationships: {
    properties: {
      from_id: { type: 'keyword' },
      from_type: { type: 'keyword' },
      to_id: { type: 'keyword' },
      to_type: { type: 'keyword' },
      relationship_type: { type: 'keyword' }, // parent | blocks | spawns | triggers | post_mortem
      notes: { type: 'text' },
      created_at: { type: 'date' },
    },
  },

  // ---- Feature 3: Recurring tasks ----
  recurrence_rules: {
    properties: {
      template_type: { type: 'keyword' }, // task | maintenance
      template_payload: { type: 'object', enabled: true },
      recurrence_type: { type: 'keyword' }, // daily | weekly | monthly | custom_cron
      recurrence_value: { type: 'keyword' },
      next_run_at: { type: 'date' },
      last_generated_at: { type: 'date' },
      active: { type: 'boolean' },
      created_at: { type: 'date' },
      ...ownerFields,
    },
  },

  // ---- Feature 4: Tags ----
  tags: {
    properties: {
      name: { type: 'keyword' },
      category: { type: 'keyword' }, // server | service | database | region | cluster | network | custom
      description: { type: 'text' },
      color: { type: 'keyword' },
      created_at: { type: 'date' },
      ...ownerFields,
    },
  },

  // ---- Auth: users ----
  users: {
    properties: {
      username: { type: 'keyword' },
      display_name: textKeyword,
      password_hash: { type: 'keyword', index: false },
      created_at: { type: 'date' },
    },
  },
};

// Create missing indices, and additively sync mappings on existing ones so new
// fields (tags, parent_id, …) are registered without dropping data.
export async function ensureIndices() {
  for (const [name, mappings] of Object.entries(INDICES)) {
    const exists = await es.indices.exists({ index: name });
    if (!exists) {
      await es.indices.create({ index: name, mappings });
      console.log(`[es] created index "${name}"`);
    } else {
      try {
        await es.indices.putMapping({ index: name, properties: mappings.properties });
        console.log(`[es] synced mapping for "${name}"`);
      } catch (e) {
        console.error(`[es] could not sync mapping for "${name}": ${e.message}`);
      }
    }
  }
}
