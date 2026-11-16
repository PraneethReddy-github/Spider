package com.example.petshop.util;

public final class Strings {
    private Strings() {}

    public static String normalize(String s) {
        return s == null ? "" : s.trim();
    }
}
