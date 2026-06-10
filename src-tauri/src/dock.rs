//! macOS dock 우클릭 메뉴 (Cursor 스타일: 새 창 + 최근 폴더).
//!
//! Tauri/tao는 dock 메뉴 API를 제공하지 않으므로 Objective-C 런타임으로
//! 앱 델리게이트 클래스에 `applicationDockMenu:`와 액션 셀렉터를 직접 추가한다.
//! 메뉴는 dock이 열릴 때마다 최신 최근 폴더 목록으로 다시 만들어진다.
#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::path::Path;
use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{msg_send, sel, MainThreadMarker, Message};
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
    let class = delegate.class();
    let types = CStr::from_bytes_with_nul(b"@@:@\0").unwrap();
    let action_types = CStr::from_bytes_with_nul(b"v@:@\0").unwrap();
    unsafe {
        class_addMethod(
            class as *const _ as *mut _,
            sel!(applicationDockMenu:).as_ptr(),
            Some(std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu,
                unsafe extern "C-unwind" fn(),
            >(dock_menu)),
            types.as_ptr(),
        );
        class_addMethod(
            class as *const _ as *mut _,
            sel!(synapseNewWindow:).as_ptr(),
            Some(std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(action_new_window)),
            action_types.as_ptr(),
        );
        class_addMethod(
            class as *const _ as *mut _,
            sel!(synapseOpenRecent:).as_ptr(),
            Some(std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(action_open_recent)),
            action_types.as_ptr(),
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
    let menu = NSMenu::new(mtm);

    unsafe {
        let new_window = NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str("새 창"),
            Some(sel!(synapseNewWindow:)),
            &NSString::from_str(""),
        );
        let _: () = msg_send![&new_window, setTarget: this];
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
            let repr = NSString::from_str(&path);
            let _: () = msg_send![&item, setRepresentedObject: &*repr];
            let _: () = msg_send![&item, setTarget: this];
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
    let path = unsafe {
        let sender = &*sender;
        let repr: Option<Retained<AnyObject>> = msg_send![sender, representedObject];
        repr.map(|r| {
            let s: &NSString = &*(Retained::as_ptr(&r) as *const NSString);
            s.retain().to_string()
        })
    };
    if let Some(path) = path {
        let _ = crate::commands::open_extra_window(app, Some(path));
    }
}
