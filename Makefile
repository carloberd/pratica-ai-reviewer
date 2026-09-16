# Release helpers.
#
#   make patch   1.0.0 -> 1.0.1
#   make minor   1.0.0 -> 1.1.0
#   make major   1.0.0 -> 2.0.0
#
# Ognuno esegue il gate, bumpa package.json, committa, tagga, pusha e crea una
# GitHub Release. I pacchetti NON si costruiscono qui: l'evento di release fa
# partire .github/workflows/publish-macos.yml e publish-windows.yml, che
# compilano sui rispettivi runner e allegano gli artefatti alla release.
#
# Il gate gira prima del bump, non dentro un hook: se fallisce non viene toccato
# niente — nessun commit, nessun tag, nessuna release da ritirare.
#
# Le release si tagliano da main. Per tagliarne una da un altro ramo (durante lo
# sviluppo iniziale, prima che main sia allineato):
#
#   make patch RELEASE_BRANCH=feat/reviewer-v1

RELEASE_BRANCH ?= main

.PHONY: patch minor major release gate

patch minor major:
	@$(MAKE) --no-print-directory release BUMP=$@

gate:
	pnpm typecheck
	pnpm lint
	pnpm test

release:
	@test -n "$(BUMP)" || { echo "Usa 'make patch', 'make minor' o 'make major'."; exit 1; }
	@command -v gh >/dev/null || { echo "gh CLI non trovato — installalo oppure crea la release a mano."; exit 1; }
	@git remote get-url origin >/dev/null 2>&1 || { echo "Nessun remote 'origin' configurato — il repo è ancora solo locale."; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "$(RELEASE_BRANCH)" || { echo "Le release si tagliano da $(RELEASE_BRANCH), non da $$(git rev-parse --abbrev-ref HEAD)."; exit 1; }
	@git diff-index --quiet HEAD -- || { echo "Working tree sporco — committa o metti da parte le modifiche."; exit 1; }
	@test -z "$$(git ls-files --others --exclude-standard)" || { echo "Ci sono file non tracciati — committali, mettili da parte o ignorali."; exit 1; }
	@git fetch --quiet origin $(RELEASE_BRANCH)
	@test -z "$$(git rev-list HEAD..FETCH_HEAD)" || { echo "Il ramo locale è indietro rispetto a origin/$(RELEASE_BRANCH) — fai pull."; exit 1; }
	@NEXT=$$(node -p 'const v=require("./package.json").version, p=v.split(".").map(Number); if(p.length!==3||p.some(Number.isNaN))throw new Error("Versione non gestita "+v+" — attesa X.Y.Z."); const t={major:[p[0]+1,0,0],minor:[p[0],p[1]+1,0],patch:[p[0],p[1],p[2]+1]}["$(BUMP)"]; "v"+t.join(".")') || exit 1; \
		! git rev-parse -q --verify "refs/tags/$$NEXT" >/dev/null || { echo "Il tag $$NEXT esiste già in locale."; exit 1; }; \
		! git ls-remote --exit-code --tags origin "refs/tags/$$NEXT" >/dev/null 2>&1 || { echo "Il tag $$NEXT esiste già su origin."; exit 1; }; \
		! gh release view "$$NEXT" >/dev/null 2>&1 || { echo "La release $$NEXT esiste già."; exit 1; }; \
		echo "Preparo $$NEXT …"
	@$(MAKE) --no-print-directory gate
	pnpm version $(BUMP)
	git push --follow-tags
	@VERSION="v$$(node -p "require('./package.json').version")"; \
		gh release create "$$VERSION" --generate-notes && \
		echo "Pubblicata $$VERSION — segui le build con: gh run watch"
