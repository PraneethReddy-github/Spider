pub struct User {
    pub id: u32,
}

impl User {
    pub fn new(id: u32) -> Self {
        Self { id }
    }

    pub fn label(&self) -> String {
        helper(self.id)
    }
}

fn helper(id: u32) -> String {
    format!("user-{id}")
}
