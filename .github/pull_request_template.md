## Summary

Describe the change and why it is needed.

## Type Of Change

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Tests
- [ ] Refactor

## Safety Checklist

- [ ] No real external provider API calls were added by default.
- [ ] Secrets are not logged, cached, sent to prompts, or exposed in dashboard events.
- [ ] User-facing errors are actionable.
- [ ] Generic fallback was preferred unless a native adapter is justified.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`

## Notes

Anything reviewers should know.
