use crate::model::User;

pub trait Store {
    fn find(&self, id: u32) -> Option<User>;

    fn count(&self) -> usize {
        0
    }
}

pub struct MemRepo {
    users: Vec<User>,
}

impl MemRepo {
    pub fn new() -> Self {
        MemRepo { users: Vec::new() }
    }
}

impl Store for MemRepo {
    fn find(&self, id: u32) -> Option<User> {
        Some(User::new(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds() {
        MemRepo::new().find(1);
    }
}
