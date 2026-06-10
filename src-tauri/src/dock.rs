//! macOS dock 우클릭 메뉴 (Cursor 스타일: 새 창 + 최근 폴더).
//!
//! Tauri/tao는 dock 메뉴 API를 제공하지 않으므로 Objective-C 런타임으로
//! 앱 델리게이트 클래스에 `applicationDockMenu:`와 액션 셀렉터를 직접 추가한다.
//! 메뉴는 dock이 열릴 때마다 최신 최근 폴더 목록으로 다시 만들어진다.
#![cfg(target_os = "macos")]

use std::path::Path;
use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
    let Some(mtm) = MainThreadMarker::new() else {
        return; // setup은 메인 스레드에서 불리지만, 아니면 조용히 포기
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = (unsafe { ns_app.delegate() }) else {
        return;
    };
    let class: &AnyClass = delegate.class();
    let cls = class as *const AnyClass as *mut AnyClass;

    type DockMenuFn = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu;
    type ActionFn = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);
    unsafe {
        class_addMethod(
            cls,
            sel!(applicationDockMenu:),
            std::mem::transmute::<DockMenuFn, Imp>(dock_menu),
            c"@@:@".as_ptr(),
        );
        class_addMethod(
            cls,
            sel!(synapseNewWindow:),
            std::mem::transmute::<ActionFn, Imp>(action_new_window),
            c"v@:@".as_ptr(),
        );
        class_addMethod(
            cls,
            sel!(synapseOpenRecent:),
            std::mem::transmute::<ActionFn, Imp>(action_open_recent),
            c"v@:@".as_ptr(),
        );
    }
}

fn recent_folders() -> Vec<String> {
    dirs::config_dir()
        .map(|d| synapse_core::recent_workspaces(&d.join("synapse")))
        .unwrap_or_default()
}

extern "C-unwind" fn dock_menu(
    this: *mut AnyObject,
    _sel: Sel,
    _app: *mut AnyObject,
) -> *mut NSMenu {
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let target = unsafe { &*this };
    let menu = NSMenu::new(mtm);

    unsafe {
        let new_window = NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str("새 창"),
            Some(sel!(synapseNewWindow:)),
            &NSString::from_str(""),
        );
        new_window.setTarget(Some(target));
        menu.addItem(&new_window);

        let recent = recent_folders();
        if !recent.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        for path in recent {
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(&name),
                Some(sel!(synapseOpenRecent:)),
                &NSString::from_str(""),
            );
            item.setRepresentedObject(Some(&NSString::from_str(&path)));
            item.setTarget(Some(target));
            menu.addItem(&item);
        }
    }
    Retained::autorelease_return(menu)
}

extern "C-unwind" fn action_new_window(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) {
    if let Some(app) = APP.get() {
        let _ = crate::commands::open_extra_window(app, None);
    }
}

extern "C-unwind" fn action_open_recent(
    _this: *mut AnyObject,
    _sel: Sel,
    sender: *mut AnyObject,
) {
    let Some(app) = APP.get() else { return };
    let sender = unsafe { &*(sender as *const NSMenuItem) };
    let path = unsafe { sender.representedObject() }
        .and_then(|obj| obj.downcast::<NSString>().ok())
        .map(|s| s.to_string());
    if let Some(path) = path {
        let _ = crate::commands::open_extra_window(app, Some(path));
    }
}
