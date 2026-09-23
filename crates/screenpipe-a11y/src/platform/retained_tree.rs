// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Provider-independent state for Windows' resumable, event-scoped UIA walk.
//! Handles never leave the owning walker thread. Only identities enter via events.

use crate::events::AccessibilityNode;
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::time::Instant;

pub(super) struct Element<K, H> {
    pub key: K,
    pub handle: H,
    pub node: AccessibilityNode,
}

pub(super) trait Provider {
    type Key: Clone + Eq + Hash;
    type Handle: Clone;
    type Error;
    fn refresh(
        &self,
        handle: &Self::Handle,
    ) -> Result<Element<Self::Key, Self::Handle>, Self::Error>;
    fn first_child(
        &self,
        handle: &Self::Handle,
    ) -> Result<Option<Element<Self::Key, Self::Handle>>, Self::Error>;
    fn next_sibling(
        &self,
        handle: &Self::Handle,
    ) -> Result<Option<Element<Self::Key, Self::Handle>>, Self::Error>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Progress {
    Complete,
    Deferred,
    Capacity,
}

enum Work<K> {
    Properties(K),
    Children { parent: K, after: Option<K> },
}

impl<K> Work<K> {
    fn key(&self) -> &K {
        match self {
            Self::Properties(key) => key,
            Self::Children { parent, .. } => parent,
        }
    }
}

struct Entry<H> {
    path: Vec<usize>,
    handle: H,
}

pub(super) struct RetainedTree<K, H> {
    pub root: AccessibilityNode,
    root_key: K,
    entries: HashMap<K, Entry<H>>,
    work: VecDeque<Work<K>>,
}

impl<K: Clone + Eq + Hash, H: Clone> RetainedTree<K, H> {
    pub fn new(element: Element<K, H>) -> Self {
        let key = element.key;
        Self {
            root: element.node,
            root_key: key.clone(),
            entries: HashMap::from([(
                key.clone(),
                Entry {
                    path: Vec::new(),
                    handle: element.handle,
                },
            )]),
            work: VecDeque::from([Work::Children {
                parent: key,
                after: None,
            }]),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn has_pending_work(&self) -> bool {
        !self.work.is_empty()
    }

    /// Unknown identities require a resync; they must never be treated as an
    /// unchanged frame. Property events preserve children. Structural events
    /// discard just that branch, including its obsolete continuation/identities.
    pub fn changed(&mut self, key: &K, structure: bool) -> bool {
        let Some(entry) = self.entries.get(key) else {
            return false;
        };
        if structure {
            let path = entry.path.clone();
            self.entries
                .retain(|_, entry| entry.path == path || !entry.path.starts_with(&path));
            self.work
                .retain(|work| work.key() != key && self.entries.contains_key(work.key()));
            self.node_mut(&path).children.clear();
            self.work.push_front(Work::Children {
                parent: key.clone(),
                after: None,
            });
        } else if self
            .work
            .iter()
            .any(|work| matches!(work, Work::Properties(pending) if pending == key))
        {
            return true;
        }
        self.work.push_front(Work::Properties(key.clone()));
        true
    }

    pub fn resync(&mut self) {
        self.changed(&self.root_key.clone(), true);
    }

    /// A deadline yields the continuation, rather than restarting a DFS prefix.
    /// The retained-node cap is separate from the per-capture request allowance.
    pub fn advance<P: Provider<Key = K, Handle = H>>(
        &mut self,
        provider: &P,
        max_calls: usize,
        max_nodes: usize,
        deadline: Instant,
    ) -> Result<Progress, P::Error> {
        let mut calls = 0;
        while let Some(work) = self.work.pop_front() {
            if calls >= max_calls || Instant::now() >= deadline {
                self.work.push_front(work);
                return Ok(Progress::Deferred);
            }
            match work {
                Work::Properties(key) => {
                    let Some(entry) = self.entries.get(&key) else {
                        continue;
                    };
                    let mut fresh = provider.refresh(&entry.handle)?;
                    if fresh.key != key {
                        // A reused/stale provider handle cannot rename a retained node.
                        self.resync();
                        return Ok(Progress::Deferred);
                    }
                    let path = entry.path.clone();
                    let node = self.node_mut(&path);
                    fresh.node.children = std::mem::take(&mut node.children);
                    *node = fresh.node;
                    self.entries.get_mut(&key).unwrap().handle = fresh.handle;
                    calls += 1;
                }
                Work::Children { parent, after } => {
                    let Some(entry) = self.entries.get(&parent) else {
                        continue;
                    };
                    // Protect both memory and recursive projection/drop depth.
                    if self.entries.len() >= max_nodes {
                        self.work.push_front(Work::Children { parent, after });
                        return Ok(Progress::Capacity);
                    }
                    if entry.path.len() >= 128 {
                        // A pathological provider depth must not pin the queue
                        // forever. Retain the bounded prefix and let unrelated
                        // event/property work continue.
                        return Ok(Progress::Capacity);
                    }
                    let mut path = entry.path.clone();
                    let fresh = match &after {
                        Some(key) => match self.entries.get(key) {
                            Some(entry) => provider.next_sibling(&entry.handle)?,
                            None => {
                                self.changed(&parent, true);
                                continue;
                            }
                        },
                        None => provider.first_child(&entry.handle)?,
                    };
                    calls += 1;
                    if let Some(fresh) = fresh {
                        if self.entries.contains_key(&fresh.key) {
                            // Provider cycles/duplicate IDs: keep bounded coverage and
                            // do not pin the continuation on the same handle forever.
                            return Ok(Progress::Capacity);
                        }
                        let node = self.node_mut(&path);
                        path.push(node.children.len());
                        node.children.push(fresh.node);
                        let key = fresh.key;
                        self.entries.insert(
                            key.clone(),
                            Entry {
                                path,
                                handle: fresh.handle,
                            },
                        );
                        self.work.push_front(Work::Children {
                            parent,
                            after: Some(key.clone()),
                        });
                        self.work.push_front(Work::Children {
                            parent: key,
                            after: None,
                        });
                    }
                }
            }
        }
        Ok(Progress::Complete)
    }

    fn node_mut(&mut self, path: &[usize]) -> &mut AccessibilityNode {
        let mut node = &mut self.root;
        for &child in path {
            node = &mut node.children[child];
        }
        node
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::Duration;

    struct Fake {
        nodes: RefCell<HashMap<usize, (String, Vec<usize>)>>,
        calls: RefCell<Vec<usize>>,
    }
    impl Fake {
        fn list(count: usize) -> Self {
            let mut nodes: HashMap<_, _> = (0..=count)
                .map(|n| (n, (format!("node {n}"), vec![])))
                .collect();
            nodes.get_mut(&0).unwrap().1 = (1..=count).collect();
            Self {
                nodes: RefCell::new(nodes),
                calls: RefCell::new(vec![]),
            }
        }
        fn element(&self, key: usize) -> Element<usize, usize> {
            Element {
                key,
                handle: key,
                node: AccessibilityNode {
                    name: Some(self.nodes.borrow()[&key].0.clone()),
                    ..Default::default()
                },
            }
        }
    }
    impl Provider for Fake {
        type Key = usize;
        type Handle = usize;
        type Error = ();
        fn refresh(&self, handle: &usize) -> Result<Element<usize, usize>, ()> {
            self.calls.borrow_mut().push(*handle);
            Ok(self.element(*handle))
        }
        fn first_child(&self, handle: &usize) -> Result<Option<Element<usize, usize>>, ()> {
            self.calls.borrow_mut().push(*handle);
            Ok(self.nodes.borrow()[handle]
                .1
                .first()
                .map(|key| self.element(*key)))
        }
        fn next_sibling(&self, handle: &usize) -> Result<Option<Element<usize, usize>>, ()> {
            self.calls.borrow_mut().push(*handle);
            for (_, children) in self.nodes.borrow().values() {
                if let Some(i) = children.iter().position(|key| key == handle) {
                    return Ok(children.get(i + 1).map(|key| self.element(*key)));
                }
            }
            Ok(None)
        }
    }
    fn advance(
        tree: &mut RetainedTree<usize, usize>,
        p: &Fake,
        calls: usize,
        cap: usize,
    ) -> Progress {
        tree.advance(p, calls, cap, Instant::now() + Duration::from_secs(1))
            .unwrap()
    }

    #[test]
    fn large_baseline_resumes_and_change_near_end_does_not_rewalk_prefix() {
        let p = Fake::list(1000);
        let mut tree = RetainedTree::new(p.element(0));
        for _ in 0..100 {
            if advance(&mut tree, &p, 30, 2000) == Progress::Complete {
                break;
            }
        }
        assert!(!tree.has_pending_work());
        assert_eq!(tree.root.children.len(), 1000);
        p.calls.borrow_mut().clear();
        p.nodes.borrow_mut().get_mut(&999).unwrap().0 = "edited near end".into();
        assert!(tree.changed(&999, false));
        assert_eq!(advance(&mut tree, &p, 30, 2000), Progress::Complete);
        assert_eq!(*p.calls.borrow(), vec![999]);
        assert_eq!(
            tree.root.children[998].name.as_deref(),
            Some("edited near end")
        );
        assert_eq!(tree.root.children[0].name.as_deref(), Some("node 1"));
        p.calls.borrow_mut().clear();
        assert_eq!(advance(&mut tree, &p, 30, 2000), Progress::Complete);
        assert!(p.calls.borrow().is_empty());
    }

    #[test]
    fn changed_branch_removes_deleted_content_and_resumes_without_touching_sibling() {
        let p = Fake::list(4);
        p.nodes.borrow_mut().get_mut(&0).unwrap().1 = vec![1, 2];
        p.nodes.borrow_mut().get_mut(&1).unwrap().1 = vec![3, 4];
        let mut tree = RetainedTree::new(p.element(0));
        advance(&mut tree, &p, 100, 100);
        p.calls.borrow_mut().clear();
        p.nodes.borrow_mut().get_mut(&1).unwrap().1 = vec![4, 3];
        tree.changed(&1, true);
        assert!(tree.root.children[0].children.is_empty());
        assert_eq!(advance(&mut tree, &p, 1, 100), Progress::Deferred);
        assert_eq!(tree.root.children[1].name.as_deref(), Some("node 2"));
        assert_eq!(advance(&mut tree, &p, 100, 100), Progress::Complete);
        assert_eq!(
            tree.root.children[0].children[0].name.as_deref(),
            Some("node 4")
        );
        assert!(!p.calls.borrow().contains(&2));
        p.nodes.borrow_mut().get_mut(&1).unwrap().1.clear();
        tree.changed(&1, true);
        advance(&mut tree, &p, 100, 100);
        assert!(!tree.changed(&3, false));
        assert_eq!(tree.len(), 3);
    }

    #[test]
    fn zero_budget_preserves_continuation_and_capacity_still_allows_property_updates() {
        let p = Fake::list(10);
        let mut tree = RetainedTree::new(p.element(0));
        assert_eq!(advance(&mut tree, &p, 0, 3), Progress::Deferred);
        assert!(p.calls.borrow().is_empty());
        assert_eq!(advance(&mut tree, &p, 100, 3), Progress::Capacity);
        assert_eq!(tree.len(), 3);
        p.nodes.borrow_mut().get_mut(&2).unwrap().0 = "fresh at capacity".into();
        tree.changed(&2, false);
        advance(&mut tree, &p, 100, 3);
        assert_eq!(
            tree.root.children[1].name.as_deref(),
            Some("fresh at capacity")
        );
        assert_eq!(advance(&mut tree, &p, 100, 20), Progress::Complete);
        assert_eq!(tree.root.children.len(), 10);
    }

    #[test]
    fn resync_discards_stale_continuations_and_reaches_late_content_again() {
        let p = Fake::list(10);
        let mut tree = RetainedTree::new(p.element(0));
        advance(&mut tree, &p, 3, 100);
        p.nodes.borrow_mut().get_mut(&0).unwrap().1 = vec![10];
        assert!(!tree.changed(&999, true));
        tree.resync();
        assert_eq!(advance(&mut tree, &p, 100, 100), Progress::Complete);
        assert_eq!(tree.root.children.len(), 1);
        assert_eq!(tree.root.children[0].name.as_deref(), Some("node 10"));
        assert_eq!(tree.len(), 2);
    }
}
