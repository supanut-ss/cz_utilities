# Provider Feasibility (2026-10-29)

This is a documentation review, not a live account test. Recheck provider documentation before implementing each adapter.

| Product | Documented access | Confirmed data | Reset/remaining status | MVP decision |
| --- | --- | --- | --- | --- |
| OpenAI API | Organization usage API with an admin credential | Organization token usage by time bucket | A separate plan limit is needed to calculate remaining; subscription limits are a different product | Candidate for API usage adapter |
| ChatGPT / Codex subscription | Usage is visible in product settings | Plan and app usage information | No supported third-party quota endpoint confirmed in this review | Show as unsupported until a supported integration is verified |
| Claude API | Organization Usage and Cost API with an Admin API key | Token consumption and cost reports | This does not represent Claude subscription session or weekly allowance | Candidate for API usage adapter |
| Claude subscription / Claude Code plan | Usage is visible in account settings or client | Session and weekly limits exist | No supported third-party quota endpoint confirmed in this review | Show as unsupported until a supported integration is verified |
| Gemini API | Google AI Studio shows active rate limits and usage | Project-level rate limits; daily request quotas reset at midnight Pacific time | A supported endpoint for current remaining quota was not confirmed in this review | Research further before adapter work |
| GitHub Copilot | GitHub billing usage REST API; user-level AI credit report accepts a fine-grained token with read-only Plan permission | AI credit usage for a personal account | Remaining allowance and reset time still require plan-specific entitlement data; organization-billed usage is separate | Candidate for an optional personal-account adapter |

## Sources

- [OpenAI organization usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)
- [OpenAI ChatGPT app usage and limits](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- [Anthropic Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
- [Claude subscription usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [GitHub billing usage REST API](https://docs.github.com/en/rest/billing/usage)
- [GitHub AI Credits usage guide](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage)

## Adapter rules

1. Never request account passwords or copy browser session cookies.
2. Ask only for the least privileged supported credential needed for the selected data source.
3. Keep API usage, billing spend, rate limits, and subscription allowance as distinct metrics.
4. Mark remaining quota and reset time as unknown unless returned directly or derived from verified limit and period data.
5. Show the source and observation time for every value.

## Step 1 outcome

The first implementation target should be the desktop foundation and a mock provider. A live adapter follows only after its authentication scope and exact quota calculation are verified against a real account. This avoids treating API usage as a subscription allowance.
