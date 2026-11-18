-- One shared Postgres, many apps: each app gets its own schema and its own login that can see nothing else.
revoke all on schema public from public;
revoke create on database postgres from public;
drop schema if exists neon_auth cascade;
do $$ begin
  for i in 1..2 loop
    execute format('drop schema if exists app_%s cascade', chr(96 + i));
    execute format('drop role if exists app_%s', chr(96 + i));
    execute format('create role app_%s login password %L', chr(96 + i), 'pw_' || chr(96 + i));
    execute format('create schema app_%s authorization app_%s', chr(96 + i), chr(96 + i));
    execute format('alter role app_%s set search_path = app_%s', chr(96 + i), chr(96 + i));
    execute format('alter role app_%s set statement_timeout = %L', chr(96 + i), '5s');
    execute format('alter role app_%s connection limit 5', chr(96 + i));
  end loop;
end $$;
-- Apps get nothing from the sign-in service: the email arrives already verified, in the signed token.
