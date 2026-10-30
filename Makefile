.PHONY: install demo test typecheck live serve worker check
install:   ## pinned dependencies from package-lock.json
	npm ci
demo:      ## fixture demo: real worker processes, one SIGKILL, no API key, no cost
	npm run demo
test:      ## unit, HTTP and process-kill tests
	npm test
typecheck:
	npm run typecheck
live:      ## one job through a real model, needs ANTHROPIC_API_KEY, costs money
	npm run live
serve:     ## HTTP API on PORT (default 8787) against .data/jobs.db
	npm run serve
worker:    ## one worker process against .data/jobs.db, exits when the queue is empty
	npm run worker
check: typecheck test demo
