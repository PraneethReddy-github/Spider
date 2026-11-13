from django.views import View


def post_list(request):
    return None


def feed(request):
    return None


class PostDetail(View):
    def get(self, request, pk):
        return None

    def post(self, request, pk):
        return None
