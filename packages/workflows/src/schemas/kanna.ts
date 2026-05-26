import { z } from '@hono/zod-openapi';

export const kannaExecutionOptionsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().min(1).optional(),
  localPath: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  taskName: z.string().min(1).optional(),
  chatTitleTemplate: z.string().min(1).optional(),
  timeoutMs: z.number().positive().optional(),
});

export const kannaExecutionSchema = z.union([z.boolean(), kannaExecutionOptionsSchema]);

export type KannaExecutionOptions = z.infer<typeof kannaExecutionOptionsSchema>;
export type KannaExecutionConfig = z.infer<typeof kannaExecutionSchema>;
