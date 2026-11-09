/** Reviewer Session tools: read the ticket's resources and record one review verdict for the Workflow. */
import { z } from 'zod'
import type { Ticket } from '../../core/index.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import { readTool, tool, type Tool } from './tool.ts'

/** The reviewer's decision: approve the change, or ask the writer to fix concrete issues. */
export const ReviewVerdictSchema = z.object({
  verdict: z.enum(['approve', 'changes']).describe('approve when the change meets the request and the tests pass; changes otherwise.'),
  summary: z.string().trim().min(1).max(2000).describe('A short review summary the writer and a person can read.'),
  issues: z.array(z.string().trim().min(1).max(500)).max(20).default([])
    .describe('For changes: concrete, actionable issues. Empty for approve.'),
}).strict()
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>
export interface ReviewerToolsHost {
  readonly resources: ResourceHost
  /** Records the verdict for this review round; called once per review. */
  review(verdict: ReviewVerdict): Promise<unknown>
}

export function reviewerTools(host: ReviewerToolsHost, ticket: Ticket): Tool[] {
  return [
    readTool('Read one page of a resource of the ticket under review that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticket.id, signal)),
    tool({
      name: 'workflow_review',
      description: 'Record the review verdict for this ticket. Inspect the checkout and the pull request, run the tests, do not modify files, then call this once. approve means the change meets the request and checks pass; changes asks the writer to fix the listed issues.',
      schema: ReviewVerdictSchema,
      execute: async args => host.review(args),
    }),
  ]
}
