-- Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- Create a table to store documents and their embeddings
create table if not exists documents (
    id uuid primary key default gen_random_uuid(),
    content text,
    metadata jsonb,
    embedding vector(1536)
);

-- Create a function to search for similar documents
create or replace function match_documents (
    query_embedding vector(1536),
    match_threshold float,
    match_count int
)
returns table (
    id uuid,
    content text,
    metadata jsonb,
    similarity float
)
language plpgsql
as $$
begin
    return query
    select
        documents.id,
        documents.content,
        documents.metadata,
        1 - (documents.embedding <=> query_embedding) as similarity
    from documents
    where 1 - (documents.embedding <=> query_embedding) > match_threshold
    order by similarity desc
    limit match_count;
end;
$$;
