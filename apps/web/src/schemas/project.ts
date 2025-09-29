import { z } from "zod";
import { baseEntitySchema } from "./common";
import { id, projectId, userId } from "./identifiers";

// Base project schema
export const projectBase = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
});

// Create input
export const projectCreateInput = projectBase;

// Update input
export const projectUpdateInput = projectBase.partial();

// Output schema
export const projectOut = baseEntitySchema.extend({
  description: z.string().nullable(),
  memberCount: z.number().optional(),
});

// Project member schema
export const projectMemberOut = z.object({
  id: id,
  projectId: projectId,
  userId: userId,
  joinedAt: z.date(),
  user: z.object({
    id: userId,
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    imageUrl: z.string().nullable(),
  }),
});

// User schema (local cache of Clerk users)
export const userOut = z.object({
  id: userId,
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Project with member count
export const projectWithMembersOut = projectOut.extend({
  _count: z
    .object({
      members: z.number(),
      recipes: z.number().optional(),
      products: z.number().optional(),
      locations: z.number().optional(),
    })
    .optional(),
});

// Project access validation input
export const projectAccessInput = z.object({
  projectId: projectId,
});

// Add member input
export const addMemberInput = z.object({
  projectId: projectId,
  email: z.string().email(),
});

// Get members input
export const getMembersInput = z.object({
  projectId: projectId,
});
