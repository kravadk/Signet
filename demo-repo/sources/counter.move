module demo::counter;
public struct Counter has key { id: UID, value: u64 }
public fun increment(c: &mut Counter) { c.value = c.value + 1; }
public fun double(c: &mut Counter) { c.value = c.value * 2; }
