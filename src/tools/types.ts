import type { z } from 'zod';
export type Register = <S extends z.ZodRawShape>(name: string, description: string, schema: S, write: boolean,
  run: (args: z.output<z.ZodObject<S>>) => Promise<unknown>, destructive?: boolean) => void;
