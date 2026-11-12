# Paiso, self-hosted: build, run and test.
#
#   make up          build the image and start it at http://127.0.0.1:8080
#   make test-unit   in-process unit tests, no server needed
#   make test-smoke  build the image and run the container smoke suite

BACKEND   := backend
PYTHON    ?= python3
PYTEST    := cd $(BACKEND) && $(PYTHON) -m pytest
REPORTS   := reports
COMPOSE   ?= docker compose

PYTEST_OPTS ?= -ra

.PHONY: up down logs ps migration migrate install-test lock test-unit test-smoke help

help:
	@grep -E '^[a-zA-Z_-]+:.*?#' $(MAKEFILE_LIST) | sed 's/:.*#/\t/'

up: # build the image and start the container at http://127.0.0.1:8080
	$(COMPOSE) up -d --build
	@echo "Paiso: http://127.0.0.1:8080"

down: # stop the container (the data volume is kept)
	$(COMPOSE) down

logs: # follow the container's log
	$(COMPOSE) logs -f

ps: # show the container's status
	$(COMPOSE) ps

migration: # autogenerate an Alembic revision from model changes: make migration M="add a column"
	cd $(BACKEND) && $(PYTHON) -m alembic revision --autogenerate -m "$(M)"

migrate: # apply pending Alembic migrations to the configured database
	cd $(BACKEND) && $(PYTHON) -m app.core.migrations

lock: # regenerate backend/requirements.lock from requirements.txt (needs uv)
	cd $(BACKEND) && uv pip compile requirements.txt --universal --python-version 3.12 \
	  --generate-hashes --no-header -o requirements.lock

install-test: # install backend and test dependencies
	cd $(BACKEND) && pip install -r requirements.txt

test-unit: # in-process unit tests, no running server
	$(PYTEST) tests/aggregator tests/unit $(PYTEST_OPTS) --junitxml=../$(REPORTS)/unit.xml

test-smoke: # build the image, start it on an empty volume and run the smoke suite
	PYTHON=$(PYTHON) scripts/smoke.sh
