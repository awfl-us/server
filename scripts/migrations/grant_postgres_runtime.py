#!/usr/bin/env python3
"""Grant AWFL production IAM SQL role access to existing and future tables.

Run as the schema owner after SQL schema creation, not as the runtime user.
Cloud SQL IAM allows connection, but SQL table permissions are separate.
"""
import argparse
import os
import re

TABLES = (
    "awfl_documents",
    "awfl_storage_stream_cursors",
    "awfl_storage_stream_events",
)


def validate_role(value):
    if not value or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._@-]{1,200}", value):
        raise ValueError("invalid IAM SQL database role")
    return value


def grant_permissions(dsn, runtime_role, expected_database="awfl_prod"):
    role = validate_role(runtime_role)
    if expected_database != "awfl_prod":
        raise ValueError("only the AWFL production database is supported")
    if not dsn:
        raise ValueError("AWFL_MIGRATION_PG_DSN is required")
    import psycopg
    from psycopg import sql

    with psycopg.connect(dsn, connect_timeout=15) as db:
        with db.cursor() as cur:
            cur.execute("SELECT current_database(), current_user")
            database, owner = cur.fetchone()
            if database != expected_database or owner != "awfl-consumer@awfl-us.iam":
                raise RuntimeError("unexpected SQL database or migration owner")
            cur.execute("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=%s)", (role,))
            if not cur.fetchone()[0]:
                raise RuntimeError("runtime IAM SQL role does not exist")
            for name in TABLES:
                cur.execute("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass(%s)",
                            ("public."+name,))
                if cur.fetchone()[0] != owner:
                    raise RuntimeError("AWFL table missing or owned by other role")
            cur.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role)))
            target=sql.SQL(", ").join(sql.SQL("public.{}").format(sql.Identifier(t)) for t in TABLES)
            cur.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {} TO {}")
                        .format(target, sql.Identifier(role)))
            cur.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                                "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}")
                        .format(sql.Identifier(role)))
            for name in TABLES:
                checks=[]
                for privilege in ("SELECT","INSERT","UPDATE","DELETE"):
                    cur.execute("SELECT has_table_privilege(%s, %s, %s)",
                                (role,"public."+name,privilege))
                    checks.append(cur.fetchone()[0])
                if not all(checks):
                    raise RuntimeError("SQL table grant verification failed")
    return len(TABLES)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn",default=os.getenv("AWFL_MIGRATION_PG_DSN"))
    parser.add_argument("--role",default=os.getenv("AWFL_POSTGRES_IAM_USER"))
    args=parser.parse_args()
    print("AWFL_RUNTIME_GRANTS_VERIFIED",grant_permissions(args.dsn,args.role),"tables")


if __name__=="__main__":
    main()
