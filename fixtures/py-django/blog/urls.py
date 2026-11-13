from django.urls import include, path
from .views import PostDetail, post_list
from . import api_urls

urlpatterns = [
    path("posts/", post_list),
    path("posts/<int:pk>/", PostDetail.as_view()),
    path("api/", include(api_urls)),
]
