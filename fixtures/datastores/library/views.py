import redis
from celery import shared_task
from django.db import connection

from .models import Author, Book

cache = redis.Redis()


def list_books(request):
    cache.get("books")
    return Book.objects.filter(published=True)


def add_author(name):
    cache.delete("books")
    return Author.objects.create(name=name)


def report():
    with connection.cursor() as cursor:
        cursor.execute("SELECT b.title, a.name FROM books b JOIN authors a ON a.id = b.author_id")


@shared_task
def index_book(book_id):
    return book_id


def publish(book_id):
    index_book.delay(book_id)
