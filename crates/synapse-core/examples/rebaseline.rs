//! 오염된 문서를 현재 텍스트로 재베이스라인하는 일회용 도구.
//! 사용: cargo run -p synapse-core --example rebaseline -- <workspace_root> <doc_id> <text_file>
//! <text_file>의 내용(frontmatter 포함 .md 전문)으로 <doc_id> 문서의 CRDT를 재구성한다.

use std::path::PathBuf;

use synapse_core::collab::CollabStore;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!(
            "사용: {} <workspace_root> <doc_id> <text_file>",
            args.first().map(String::as_str).unwrap_or("rebaseline")
        );
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[1]);
    let id = &args[2];
    let text = std::fs::read_to_string(&args[3])?;
    let store = CollabStore::local(root, "cleanup-tool".to_string());
    store.rebaseline(id, &text)?;
    let restored = store.doc_text(id).unwrap_or_default();
    println!("rebaseline 완료: {id} — 텍스트 {}바이트 복원", restored.len());
    Ok(())
}
